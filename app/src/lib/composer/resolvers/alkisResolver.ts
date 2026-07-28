/**
 * alkisResolver.ts — aus Katasterdaten werden Beobachtungen.
 *
 * Die entscheidende Frage dieses Moduls ist nicht technisch, sondern fachlich:
 * **wer gewinnt, wenn der Nutzer ein Grundstück zeichnet und das Kataster ein
 * anderes kennt?**
 *
 * Die Provenienz-Rangfolge stellt `user` über `measured`, mit gutem Grund — wer
 * dort wohnt, weiß, was ihm gehört. Aber ein per Fingertipp auf ein Luftbild
 * gezeichnetes Viereck ist keine Willenserklärung, sondern eine Näherung, und
 * die amtliche Grenze ist auf Zentimeter vermessen.
 *
 * Die Auflösung liegt darin, beide Aussagen als das zu nehmen, was sie sind:
 *
 *   • Die Zeichnung sagt **welches** Grundstück gemeint ist.
 *   • Das Kataster sagt, **wo genau** dessen Grenzen verlaufen.
 *
 * Deckt sich die Zeichnung deutlich mit genau einem Flurstück, wird dessen
 * amtliche Geometrie übernommen — die Absicht des Nutzers bleibt gewahrt, die
 * Genauigkeit steigt. Trifft sie mehrere oder keines, war offensichtlich etwas
 * anderes gemeint, und die Zeichnung bleibt stehen.
 */

import type { GeoPoint, LocalPolygon, ParcelInput } from '../types'
import type { AlkisFeature, AlkisSite, CadastreBuildingProps, ParcelProps } from '../sources/alkis'
import { outerRing } from '../sources/alkis'
import { geoToLocal, normalizePolygon, orientedBounds, polygonAreaSqm, polygonBBox, rotatePolygon } from '../geo'
import { pointInPolygon } from '../frame'
import type { SourceRef } from '../provenance'

export const ALKIS_SOURCE: SourceRef = {
  id: 'alkis-nrw',
  label: 'ALKIS Liegenschaftskataster NRW',
}

export function alkisSourceRef(site: AlkisSite): SourceRef {
  return { ...ALKIS_SOURCE, version: site.version, fetchedAt: new Date().toISOString() }
}

/* ────────────────────────────── Flurstücke ──────────────────────────── */

export interface CadastralParcel {
  objid: string
  /** Umriss in WGS84. */
  ring: GeoPoint[]
  /** Amtliche Fläche in m² — nicht die aus der Geometrie gerechnete. */
  areaSqm: number
  /** „Borghorst, Flur 017, Flurstück 666" */
  label: string
  /** Lagebezeichnung, meist der Straßenname. */
  street?: string
}

export function extractParcels(site: AlkisSite): CadastralParcel[] {
  const out: CadastralParcel[] = []
  for (const f of site.parcels) {
    const ring = outerRing(f.geometry)
    if (ring.length < 4) continue
    const p = f.properties
    out.push({
      objid: p.objid,
      ring,
      areaSqm: p.flaeche,
      label: [p.gemarkung, p.flur ? `Flur ${p.flur}` : '', p.flstnrzae ? `Flurstück ${p.flstnrzae}` : '']
        .filter(Boolean).join(', '),
      street: p.lagebeztxt,
    })
  }
  return out
}

/** Anteil der Punkte eines Rings, die in einem Polygon liegen (0…1). */
function overlapFraction(ring: GeoPoint[], parcel: GeoPoint[]): number {
  if (ring.length === 0 || parcel.length < 3) return 0
  // In einem gemeinsamen metrischen Rahmen prüfen, sonst verzerrt die
  // Längengrad-Stauchung das Ergebnis in unseren Breiten um ~40 %.
  const origin = ring[0]
  const poly = parcel.map((p) => geoToLocal(origin, p))
  let inside = 0
  for (const p of ring) if (pointInPolygon(geoToLocal(origin, p), poly)) inside++
  return inside / ring.length
}

/**
 * Das Flurstück, das der Nutzer gemeint hat.
 *
 * Kriterium ist die Überdeckung der gezeichneten Ecken: liegen mindestens drei
 * Viertel von ihnen in einem einzigen Flurstück, ist die Absicht eindeutig.
 * Bewusst nicht der Flächenvergleich — jemand, der grob um sein Haus
 * herumfährt, zeichnet fast immer kleiner als sein Grundstück.
 */
export function matchDrawnParcel(
  drawn: GeoPoint[] | undefined,
  parcels: CadastralParcel[],
  minOverlap = 0.75,
): CadastralParcel | undefined {
  if (!drawn || drawn.length < 3 || parcels.length === 0) return undefined
  let best: { parcel: CadastralParcel; frac: number } | undefined
  for (const parcel of parcels) {
    const frac = overlapFraction(drawn, parcel.ring)
    if (!best || frac > best.frac) best = { parcel, frac }
  }
  return best && best.frac >= minOverlap ? best.parcel : undefined
}

/** Das Flurstück unter einem Punkt — für den Fall ohne Zeichnung. */
export function parcelAtPoint(at: GeoPoint, parcels: CadastralParcel[]): CadastralParcel | undefined {
  for (const parcel of parcels) {
    const origin = parcel.ring[0]
    const poly = parcel.ring.map((p) => geoToLocal(origin, p))
    if (pointInPolygon(geoToLocal(origin, at), poly)) return parcel
  }
  return undefined
}

/**
 * Ein amtliches Flurstück in den Rahmen bringen, den die Detektoren erwarten —
 * dieselbe Aufbereitung wie für die gezeichnete Fläche: in die eigenen Achsen
 * gedreht, auf den Ursprung normiert.
 */
export function parcelToInput(parcel: CadastralParcel): { input: ParcelInput; origin: GeoPoint; rotationRad: number } | undefined {
  const origin: GeoPoint = {
    lat: Math.max(...parcel.ring.map((p) => p.lat)),
    lng: Math.min(...parcel.ring.map((p) => p.lng)),
  }
  const local = parcel.ring.map((p) => geoToLocal(origin, p))
  const ob = orientedBounds(local)
  const aligned: LocalPolygon = normalizePolygon(rotatePolygon(local, -ob.angle))
  const bb = polygonBBox(aligned)
  const widthM = bb.maxX - bb.minX
  const depthM = bb.maxY - bb.minY
  if (widthM < 2 || depthM < 2) return undefined

  return {
    input: {
      polygon: aligned,
      // Die amtliche Fläche schlägt die aus der Geometrie gerechnete: sie ist
      // die rechtlich maßgebliche Zahl und schon gerundet veröffentlicht.
      areaSqm: Math.round(parcel.areaSqm || polygonAreaSqm(local)),
      widthM: Math.round(widthM * 10) / 10,
      depthM: Math.round(depthM * 10) / 10,
      orientationDeg: Math.round(((-ob.angle * 180) / Math.PI) * 10) / 10,
    },
    origin,
    rotationRad: -ob.angle,
  }
}

/* ────────────────────────────── Gebäude ─────────────────────────────── */

/** Welche Katasterfunktionen als Wohngebäude gelten. */
const RESIDENTIAL = /wohn|gemischt|geschäft/i
/** Und welche als Nebengebäude — die zählen nicht als „das Haus". */
const ANCILLARY = /garage|überdachung|schuppen|carport|nebengeb|gartenhaus/i

export interface CadastreBuilding {
  ring: GeoPoint[]
  areaSqm: number
  /** Klartext aus dem Kataster. */
  usage?: string
  functionText?: string
  residential: boolean
  ancillary: boolean
}

export function extractCadastreBuildings(site: AlkisSite): CadastreBuilding[] {
  const out: CadastreBuilding[] = []
  for (const f of site.buildings as AlkisFeature<CadastreBuildingProps>[]) {
    const ring = outerRing(f.geometry)
    if (ring.length < 4) continue
    const origin = ring[0]
    const areaSqm = polygonAreaSqm(ring.map((p) => geoToLocal(origin, p)))
    if (areaSqm < 4) continue
    const usage = f.properties.gebnutzbez
    const functionText = f.properties.funktion
    const text = `${usage ?? ''} ${functionText ?? ''}`
    out.push({
      ring,
      areaSqm: Math.round(areaSqm),
      usage,
      functionText,
      residential: RESIDENTIAL.test(text),
      ancillary: ANCILLARY.test(text),
    })
  }
  return out
}

/**
 * Das Hauptgebäude auf einem Flurstück: das größte, das kein Nebengebäude ist.
 * Das Kataster unterscheidet Wohnhaus und Garage ausdrücklich — eine Semantik,
 * die OSM in dieser Verlässlichkeit nicht hat.
 */
export function mainBuildingOnParcel(
  buildings: CadastreBuilding[],
  parcel: CadastralParcel,
): CadastreBuilding | undefined {
  const origin = parcel.ring[0]
  const poly = parcel.ring.map((p) => geoToLocal(origin, p))
  const on = buildings.filter((b) => {
    const c = b.ring.reduce(
      (acc, p) => ({ lat: acc.lat + p.lat / b.ring.length, lng: acc.lng + p.lng / b.ring.length }),
      { lat: 0, lng: 0 },
    )
    return pointInPolygon(geoToLocal(origin, c), poly)
  })
  const primary = on.filter((b) => !b.ancillary)
  const pool = primary.length > 0 ? primary : on
  if (pool.length === 0) return undefined
  return pool.reduce((best, b) => (b.areaSqm > best.areaSqm ? b : best))
}

/* ────────────────────────────── Nutzung ─────────────────────────────── */

/** Was die Fläche laut Kataster ist — Grundlage für Beläge und Vegetation. */
export interface LandUseArea {
  ring: GeoPoint[]
  kind: 'residential' | 'road' | 'green' | 'water' | 'wood' | 'commercial' | 'other'
  name?: string
}

const USE_MAP: [RegExp, LandUseArea['kind']][] = [
  [/wohnbau/i, 'residential'],
  [/straßenverkehr|weg|platz|bahnverkehr/i, 'road'],
  [/gehölz|wald/i, 'wood'],
  [/grünland|garten|sport|freizeit|friedhof|landwirtschaft|heide|moor/i, 'green'],
  [/wasser|fließgewässer|stehendes/i, 'water'],
  [/industrie|gewerbe|handel|versorgung|entsorgung/i, 'commercial'],
]

export function extractLandUse(site: AlkisSite): LandUseArea[] {
  const out: LandUseArea[] = []
  for (const f of site.landUse) {
    const ring = outerRing(f.geometry)
    if (ring.length < 4) continue
    const art = f.properties.nutzart ?? ''
    const kind = USE_MAP.find(([re]) => re.test(art))?.[1] ?? 'other'
    out.push({ ring, kind, name: f.properties.name })
  }
  return out
}
