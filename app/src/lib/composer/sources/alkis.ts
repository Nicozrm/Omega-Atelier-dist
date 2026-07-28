/**
 * alkis.ts — das amtliche Liegenschaftskataster (ALKIS) als Quelle.
 *
 * Nordrhein-Westfalen veröffentlicht ALKIS als **OGC API Features**: eine
 * bbox-abfragbare GeoJSON-Schnittstelle ohne Schlüssel, ohne Anmeldung, mit
 * dl-de/zero-2.0. Das liefert genau die drei Dinge, die der Pipeline bisher am
 * meisten gefehlt haben:
 *
 *   • **Flurstücke** — die vermessene Grundstücksgrenze samt amtlicher Fläche,
 *     Gemarkung, Flur und Flurstücksnummer. Damit wird Phase 1 zum ersten Mal
 *     eine Messung statt einer Zeichnung.
 *   • **Gebäude und Bauwerke** — Umrisse aus dem Kataster, mit Nutzungsart
 *     (Wohnhaus, Garage, Überdachung …). Genauer als OSM und mit einer
 *     Semantik, die OSM in dieser Form nicht kennt.
 *   • **Nutzung** — was die Fläche tatsächlich ist: Wohnbaufläche, Garten,
 *     Straßenverkehr, Gehölz, Wasser. Das ist Phase 3 und 4 in amtlicher
 *     Qualität.
 *
 * Warum das hier steht und nicht LoD2: die LoD2-Kacheln des Landes sind
 * Einzeldateien von rund 40 MB. Für eine einzige Firsthöhe wäre das im Browser
 * nicht vertretbar — LoD2 braucht die serverseitige Stufe. ALKIS liefert
 * dagegen pro Abfrage wenige Kilobyte und lässt sich sofort anbinden.
 *
 * Wie bei Overpass ist der Transport injizierbar und der Cache-Schlüssel
 * geografisch.
 */

import type { GeoPoint } from '../types'

/* ────────────────────────────── Rohdaten ────────────────────────────── */

/**
 * GeoJSON aus einer OGC API Features. Koordinaten sind CRS84, also
 * **[lon, lat]** — dieselbe Falle wie bei Overpass, deshalb wieder ein eigener
 * Typ und genau eine Umrechnungsstelle.
 */
export type LonLat = [number, number]

export interface AlkisFeature<P = Record<string, unknown>> {
  type: 'Feature'
  id?: string
  geometry: {
    type: 'Polygon' | 'MultiPolygon' | 'Point' | 'LineString'
    coordinates: unknown
  } | null
  properties: P
}

export interface AlkisCollection<P = Record<string, unknown>> {
  features: AlkisFeature<P>[]
  numberMatched?: number
  numberReturned?: number
}

/** Die einzige Stelle, an der aus CRS84-Koordinaten App-Koordinaten werden. */
export function toGeo(p: LonLat): GeoPoint {
  return { lat: p[1], lng: p[0] }
}

/** Äußerer Ring eines (Multi-)Polygons — Löcher interessieren hier nicht. */
export function outerRing(geometry: AlkisFeature['geometry']): GeoPoint[] {
  if (!geometry) return []
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as LonLat[][]
    return (rings[0] ?? []).map(toGeo)
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates as LonLat[][][]
    // Bei mehrteiligen Flurstücken zählt der größte Teil.
    let best: LonLat[] = []
    for (const poly of polys) {
      const ring = poly[0] ?? []
      if (ring.length > best.length) best = ring
    }
    return best.map(toGeo)
  }
  return []
}

/* ────────────────────────────── Fachdaten ───────────────────────────── */

export interface ParcelProps {
  objid: string
  /** Amtliche Fläche in m². */
  flaeche: number
  gemarkung: string
  flur: string
  /** Flurstücksnummer (Zähler). */
  flstnrzae: string
  /** Nenner, wo vorhanden. */
  flstnrnen?: string
  gemeinde: string
  kreis: string
  /** Lagebezeichnung, meist der Straßenname. */
  lagebeztxt?: string
  /** Datenstand. */
  aktualit?: string
}

export interface CadastreBuildingProps {
  /** Nutzungsart im Klartext, z. B. „Wohnhaus". */
  gebnutzbez?: string
  /** Funktion, z. B. „Garage", „Überdachung". */
  funktion?: string
  aktualit?: string
}

export interface LandUseProps {
  /** Nutzungsart, z. B. „Wohnbaufläche", „Straßenverkehr", „Gehölz". */
  nutzart?: string
  bez?: string
  name?: string
}

/* ────────────────────────────── Transport ───────────────────────────── */

export interface AlkisTransport {
  items<P>(collection: string, bbox: string, limit: number, signal?: AbortSignal): Promise<AlkisCollection<P>>
}

export const ALKIS_BASE = 'https://ogc-api.nrw.de/lika/v1'

export class HttpAlkisTransport implements AlkisTransport {
  constructor(
    private readonly base = ALKIS_BASE,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly timeoutMs = 20_000,
  ) {}

  async items<P>(collection: string, bbox: string, limit: number, signal?: AbortSignal): Promise<AlkisCollection<P>> {
    const url = `${this.base}/collections/${collection}/items?bbox=${bbox}&limit=${limit}&f=json`
    const res = await this.fetchFn(url, {
      headers: { Accept: 'application/geo+json,application/json' },
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`ALKIS ${res.status} (${collection})`)
    return (await res.json()) as AlkisCollection<P>
  }
}

/* ────────────────────────────── Quelle ──────────────────────────────── */

export interface AlkisSite {
  parcels: AlkisFeature<ParcelProps>[]
  buildings: AlkisFeature<CadastreBuildingProps>[]
  landUse: AlkisFeature<LandUseProps>[]
  /** Datenstand der Quelle, aus dem ersten Flurstück übernommen. */
  version?: string
}

export interface AlkisCache {
  get(key: string): { site: AlkisSite; storedAt: number } | undefined
  set(key: string, v: { site: AlkisSite; storedAt: number }): void
}

class MemoryAlkisCache implements AlkisCache {
  private readonly map = new Map<string, { site: AlkisSite; storedAt: number }>()
  get(k: string) { return this.map.get(k) }
  set(k: string, v: { site: AlkisSite; storedAt: number }) { this.map.set(k, v) }
}

/** Kataster ändert sich in Monaten, nicht Stunden. */
export const ALKIS_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Eine Bounding-Box um den Punkt. ALKIS deckt nur NRW ab — außerhalb liefert
 * die Schnittstelle schlicht nichts, und die Pipeline fällt zurück. Genau so
 * soll eine regionale Quelle sich verhalten: keine Sonderbehandlung, kein
 * Fehler, nur weniger Beobachtungen.
 */
export function bboxAround(at: GeoPoint, radiusM: number): string {
  const dLat = radiusM / 111_320
  const dLng = radiusM / (111_320 * Math.cos((at.lat * Math.PI) / 180))
  return [
    (at.lng - dLng).toFixed(6), (at.lat - dLat).toFixed(6),
    (at.lng + dLng).toFixed(6), (at.lat + dLat).toFixed(6),
  ].join(',')
}

export class AlkisSource {
  constructor(
    private readonly transport: AlkisTransport = new HttpAlkisTransport(),
    private readonly cache: AlkisCache = new MemoryAlkisCache(),
  ) {}

  /**
   * Liefert Flurstücke, Katastergebäude und Nutzungsflächen im Umkreis.
   * Wirft nie: außerhalb NRW oder bei Ausfall kommt `undefined` zurück.
   */
  async fetchSite(at: GeoPoint, radiusM = 90, signal?: AbortSignal): Promise<AlkisSite | undefined> {
    const bbox = bboxAround(at, radiusM)
    const key = `alkis/v1/${bbox}`
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.storedAt < ALKIS_TTL_MS) return hit.site

    try {
      // Die drei Ebenen parallel — es sind unabhängige Sammlungen, und die
      // Schnittstelle verträgt das problemlos.
      const [parcels, buildings, landUse] = await Promise.all([
        this.transport.items<ParcelProps>('flurstueck', bbox, 60, signal),
        this.transport.items<CadastreBuildingProps>('gebaeude_bauwerk', bbox, 120, signal),
        this.transport.items<LandUseProps>('nutzung', bbox, 60, signal),
      ])
      const site: AlkisSite = {
        parcels: parcels.features ?? [],
        buildings: buildings.features ?? [],
        landUse: landUse.features ?? [],
        version: (parcels.features?.[0]?.properties as ParcelProps | undefined)?.aktualit,
      }
      if (site.parcels.length === 0 && site.buildings.length === 0) return undefined
      this.cache.set(key, { site, storedAt: Date.now() })
      return site
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      return hit?.site
    }
  }
}

export const alkisSource = new AlkisSource()
