/**
 * analysisEngine.ts — the MapAnalysisEngine.
 *
 * Orchestrates the modular pipeline
 *
 *   MapProvider → SatelliteImage → Property → Building → Roof
 *              → Vegetation → Terrain → Confidence → DetectedScene
 *
 * Every detector is a swappable {@link DetectorModule}; the engine merges any
 * caller-supplied modules over the {@link defaultPipeline}. The run is async and
 * cancelable (via `AbortSignal`), reports granular progress, and inserts a
 * configurable per-phase delay so the UI can play its cinematic without blocking
 * — in tests the delay is 0, so a full analysis resolves in microseconds.
 */

import type {
  AnalysisContext,
  AnalysisProgress,
  ParcelInput,
  BuildingFeature,
  DetectedScene,
  DetectorModule,
  GeoPoint,
  MapView,
  PhaseId,
  PropertyFeature,
  RoofFeature,
  SatelliteImage,
  TerrainProfile,
  VegetationFeature,
} from './types'
import { SeededRng } from './rng'
import {
  geoToLocal, normalizePolygon, orientedBounds, polygonAreaSqm, polygonBBox, rotatePolygon,
} from './geo'
import { plainFrame, type LocalFrame } from './frame'
import { polygonCentroid } from './geo'
import { osmSource, type OsmSource } from './sources/overpass'
import { alkisSource, type AlkisSource } from './sources/alkis'
import { SOURCE_BUDGET_MS } from './sources/deadline'
import {
  alkisSourceRef, extractCadastreBuildings, extractLandUse, extractParcels,
  matchDrawnParcel, parcelAtPoint, parcelToInput, structuresOnParcel,
} from './resolvers/alkisResolver'
import {
  extractBuildings, extractPois, extractRoads, pickOwnBuilding, summariseNeighbourhood,
  OSM_SOURCE,
} from './resolvers/osmResolver'
import { defaultMapProvider, type MapProvider } from './mapProvider'
import { PropertyDetector } from './propertyDetector'
import { BuildingRecognizer } from './buildingDetector'
import { RoofDetector } from './roofDetector'
import { TerrainRecognizer, type TerrainInput } from './terrainDetector'
import { VegetationRecognizer, type VegetationInput } from './vegetationDetector'
import { computeConfidence } from './confidenceEngine'

export interface DetectorPipeline {
  property: DetectorModule<SatelliteImage, PropertyFeature>
  building: DetectorModule<PropertyFeature, BuildingFeature>
  roof: DetectorModule<BuildingFeature, RoofFeature>
  vegetation: DetectorModule<VegetationInput, VegetationFeature>
  terrain: DetectorModule<TerrainInput, TerrainProfile>
}

/** The stock detector pipeline — every module can be overridden per run. */
export const defaultPipeline: DetectorPipeline = {
  property: PropertyDetector,
  building: BuildingRecognizer,
  roof: RoofDetector,
  vegetation: VegetationRecognizer,
  terrain: TerrainRecognizer,
}

export const PHASE_LABEL: Record<PhaseId, string> = {
  satellite: 'Satellitenbild geladen',
  property: 'Grundstück erkannt',
  building: 'Gebäude erkannt',
  roof: 'Dach vermessen',
  vegetation: 'Vegetation erkannt',
  terrain: 'Gelände erkannt',
  scene: 'Szene aufgebaut',
  project: 'Digital Twin wird erstellt',
}

/** Execution order of the analysis phases (detection only). */
export const ANALYSIS_PHASES: PhaseId[] = [
  'satellite',
  'property',
  'building',
  'roof',
  'vegetation',
  'terrain',
]

export interface ChecklistItem {
  id: string
  label: string
  phases: PhaseId[]
}

/** The five progress checkpoints shown in the wizard's analysis step. */
export const ANALYSIS_CHECKLIST: ChecklistItem[] = [
  { id: 'property', label: 'Grundstück erkannt', phases: ['satellite', 'property'] },
  { id: 'building', label: 'Gebäude & Dach erkannt', phases: ['building', 'roof'] },
  { id: 'vegetation', label: 'Vegetation erkannt', phases: ['vegetation'] },
  { id: 'terrain', label: 'Gelände erkannt', phases: ['terrain'] },
  { id: 'twin', label: 'Digital Twin wird erstellt', phases: ['scene', 'project'] },
]

export interface AnalysisInput {
  view: MapView
  tap: GeoPoint
  /**
   * The parcel the user drew on the map. When present it **replaces** every
   * derived parcel geometry — it is the most reliable input the pipeline has.
   */
  polygon?: GeoPoint[]
}

/**
 * Project a drawn parcel into the frame the detectors work in.
 *
 * Three steps, each of which matters:
 *   1. **geo → metres**, anchored on the parcel's own north-west corner.
 *   2. **rotate into the parcel's own axes** (minimum-area bounds). A plot is
 *      almost never aligned to north, and every downstream module reasons in
 *      "along the street / into the plot" terms — so the plot's true frontage
 *      and depth are what they need, not the north-aligned bounding box, which
 *      over-states both.
 *   3. **normalise to the origin**, because the scene builder assumes the
 *      parcel lives in [0, width] × [0, depth].
 *
 * Returns `undefined` for anything that is not a usable ring (fewer than three
 * points, or a degenerate sliver), so the caller falls back cleanly.
 */
export function prepareParcel(
  polygon: GeoPoint[] | undefined,
): { parcel: ParcelInput; frame: LocalFrame } | undefined {
  if (!polygon || polygon.length < 3) return undefined

  // North-west corner: smallest longitude, largest latitude.
  const origin: GeoPoint = {
    lat: Math.max(...polygon.map((p) => p.lat)),
    lng: Math.min(...polygon.map((p) => p.lng)),
  }
  const local = polygon.map((p) => geoToLocal(origin, p))
  const areaSqm = polygonAreaSqm(local)
  if (!Number.isFinite(areaSqm) || areaSqm < 4) return undefined

  const ob = orientedBounds(local)
  const aligned = normalizePolygon(rotatePolygon(local, -ob.angle))
  const bb = polygonBBox(aligned)
  const widthM = bb.maxX - bb.minX
  const depthM = bb.maxY - bb.minY
  if (widthM < 2 || depthM < 2) return undefined

  // Derselbe Rahmen, in den später jede weitere Quelle projiziert wird.
  const rotatedBB = polygonBBox(rotatePolygon(local, -ob.angle))
  const frame: LocalFrame = {
    origin,
    rotationRad: -ob.angle,
    offset: { x: -rotatedBB.minX, y: -rotatedBB.minY },
  }

  return {
    parcel: {
      polygon: aligned,
      areaSqm: Math.round(areaSqm),
      widthM: Math.round(widthM * 10) / 10,
      depthM: Math.round(depthM * 10) / 10,
      // Local y runs south, so a positive rotation in that frame is a bearing
      // measured clockwise from north once negated.
      orientationDeg: Math.round(((-ob.angle * 180) / Math.PI) * 10) / 10,
    },
    frame,
  }
}

export interface AnalyzeOptions {
  provider?: MapProvider
  /**
   * Die OSM-Quelle. `null` schaltet sie ab (Tests, Offline-Modus) — die
   * Pipeline fällt dann vollständig auf ihre Annahmen zurück.
   */
  osm?: OsmSource | null
  /** Das Liegenschaftskataster. `null` schaltet es ab. */
  alkis?: AlkisSource | null
  pipeline?: Partial<DetectorPipeline>
  onProgress?: (p: AnalysisProgress) => void
  signal?: AbortSignal
  /** Minimum ms each phase occupies (cinematic pacing). Default 0. */
  phaseDelayMs?: number
}

/** Thrown when a run is aborted via its `AbortSignal`. */
export class AnalysisCanceledError extends Error {
  constructor(message = 'Analyse abgebrochen') {
    super(message)
    this.name = 'AnalysisCanceledError'
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AnalysisCanceledError())
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new AnalysisCanceledError())
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisCanceledError()
}

/**
 * Run the detection pipeline for one tap and resolve to a {@link DetectedScene}.
 * Rejects with {@link AnalysisCanceledError} if the signal aborts.
 */
export async function runAnalysis(input: AnalysisInput, opts: AnalyzeOptions = {}): Promise<DetectedScene> {
  const provider = opts.provider ?? defaultMapProvider
  const pipeline: DetectorPipeline = { ...defaultPipeline, ...opts.pipeline }
  const delay = opts.phaseDelayMs ?? 0
  const { signal, onProgress } = opts

  const total = ANALYSIS_PHASES.length
  let index = 0
  const emit = (phase: PhaseId, confidence?: number, detail?: string) => {
    index += 1
    onProgress?.({ phase, index, total, label: PHASE_LABEL[phase], confidence, detail })
  }

  throwIfAborted(signal)

  // 1. Satellite capture
  const image = provider.capture(input.tap, input.view)
  const rng = new SeededRng(image.seed)
  let prepared = prepareParcel(input.polygon)
  emit('satellite', undefined, provider.label)

  // ── Echte Quellen ───────────────────────────────────────────────────
  // Beide Abrufe laufen **parallel**: nacheinander addieren sich ihre
  // Wartezeiten, und ein Wizard, der auf zwei fremde Dienste hintereinander
  // wartet, steht im schlechten Fall doppelt so lange still. Ausgewertet wird
  // trotzdem in fester Reihenfolge — das Kataster kann den Bezugsrahmen
  // verschieben, und OSM muss in den endgültigen Rahmen projiziert werden.
  //
  // Beide Quellen sind mit einer Frist versehen (siehe sources/deadline) und
  // werfen nie: fällt eine aus, bleibt ihr Beitrag einfach leer und die
  // Pipeline arbeitet mit Annahmen weiter.
  const alkisSrc = opts.alkis === undefined ? alkisSource : opts.alkis
  const osmSrc = opts.osm === undefined ? osmSource : opts.osm

  // Der Abruf dauert je nach Laune der Dienste bis zu einer Frist lang. Solange
  // muss die Anzeige laufen: ein Ring, der sekundenlang auf derselben Zahl
  // steht, ist für den Benutzer ein Absturz. Der Anteil ist dabei nicht
  // geschätzt, sondern schlicht die verstrichene Zeit im Verhältnis zur
  // längsten Frist — er läuft also genau so schnell wie die Geduld zu Ende geht.
  const sourceBudget = Math.max(
    alkisSrc ? SOURCE_BUDGET_MS.alkis : 0,
    osmSrc ? SOURCE_BUDGET_MS.overpass : 0,
  )
  const startedAt = Date.now()
  const landed: string[] = []
  const tick = () => {
    if (sourceBudget <= 0) return
    const share = Math.min(1, (Date.now() - startedAt) / sourceBudget)
    onProgress?.({
      phase: 'satellite', index, total, label: PHASE_LABEL.satellite,
      // Zwischen Phase 1 und 2 — nie darüber hinaus, sonst überholt die
      // Wartezeit ein Ergebnis, das noch gar nicht vorliegt.
      fraction: (index + share) / total,
      detail: landed.length > 0 ? `${landed.join(' · ')} geladen` : 'Quellen werden abgefragt',
    })
  }
  const ticker = sourceBudget > 0 ? setInterval(tick, 120) : undefined
  const note = (name: string) => { landed.push(name); tick() }

  let alkisSite: Awaited<ReturnType<AlkisSource['fetchSite']>>
  let osmResult: Awaited<ReturnType<OsmSource['fetchSite']>>
  try {
    ;[alkisSite, osmResult] = await Promise.all([
      alkisSrc
        ? alkisSrc.fetchSite(image.center, 90, signal).then((r) => (note('Kataster'), r))
        : Promise.resolve(undefined),
      osmSrc
        ? osmSrc.fetchSite(image.center, signal).then((r) => (note('Umgebung'), r))
        : Promise.resolve(undefined),
    ])
  } catch (err) {
    // Ein Abbruch aus der Quellen-Schicht kommt als DOMException herein; der
    // Wizard kennt aber nur `AnalysisCanceledError`. Die Umwandlung gehört
    // hierher, damit die Quellen nichts über den Wizard wissen müssen.
    throwIfAborted(signal)
    throw err
  } finally {
    if (ticker !== undefined) clearInterval(ticker)
  }
  throwIfAborted(signal)

  let alkisObs: AnalysisContext['alkis']
  if (alkisSite) {
    const parcels = extractParcels(alkisSite)
    const buildings = extractCadastreBuildings(alkisSite)
    // Die Zeichnung sagt, welches Grundstück gemeint ist; das Kataster sagt,
    // wo dessen Grenzen genau verlaufen. Ohne Zeichnung entscheidet der Tipp.
    const own = matchDrawnParcel(input.polygon, parcels) ?? parcelAtPoint(image.center, parcels)
    // Haupt- und Nebengebäude kommen aus einem Durchlauf: die Zuordnung „was
    // steht auf diesem Flurstück" wird nur einmal berechnet, und beide Antworten
    // stammen garantiert aus derselben Auswahl.
    const structures = own ? structuresOnParcel(buildings, own) : { ancillary: [] }
    alkisObs = {
      parcels, buildings, own,
      ownBuilding: structures.main,
      ownAncillary: structures.ancillary,
      landUse: extractLandUse(alkisSite),
      source: alkisSourceRef(alkisSite),
    }
    // Amtliche Grenze übernehmen — dieselbe Aufbereitung wie für die
    // gezeichnete Fläche, damit alles Nachgelagerte unverändert weiterläuft.
    if (own) {
      const converted = parcelToInput(own)
      if (converted) {
        prepared = {
          parcel: converted.input,
          frame: {
            origin: converted.origin,
            rotationRad: converted.rotationRad,
            // `parcelToInput` normiert bereits auf den Ursprung.
            offset: { x: 0, y: 0 },
          },
        }
      }
    }
  }

  const frame = prepared?.frame ?? plainFrame(image.center)
  const ctx: AnalysisContext = {
    rng, image, frame,
    ...(prepared ? { parcel: prepared.parcel } : {}),
    ...(alkisObs ? { alkis: alkisObs } : {}),
  }

  // OSM wird erst jetzt ausgewertet — im endgültigen Rahmen.
  if (osmResult) {
    const parcelPoly = prepared?.parcel.polygon
    const reference = parcelPoly && parcelPoly.length >= 3
      ? polygonCentroid(parcelPoly)
      : { x: 0, y: 0 }
    const buildings = extractBuildings(osmResult, frame, parcelPoly)
    const roads = extractRoads(osmResult, frame, reference)
    const pois = extractPois(osmResult, frame, reference)
    ctx.osm = {
      buildings,
      own: pickOwnBuilding(buildings),
      roads,
      pois,
      summary: summariseNeighbourhood(buildings, roads, pois),
      source: { ...OSM_SOURCE, version: osmResult.timestamp, fetchedAt: new Date().toISOString() },
    }
  }
  throwIfAborted(signal)
  await sleep(delay, signal)
  throwIfAborted(signal)

  // 2. Property
  const property = pipeline.property.run(image, ctx)
  emit('property', property.confidence)
  await sleep(delay, signal)
  throwIfAborted(signal)

  // 3. Building
  const building = pipeline.building.run(property, ctx)
  emit('building', building.confidence)
  await sleep(delay, signal)
  throwIfAborted(signal)

  // 4. Roof
  const roof = pipeline.roof.run(building, ctx)
  emit('roof', roof.confidence)
  await sleep(delay, signal)
  throwIfAborted(signal)

  // 5. Vegetation
  const vegetation = pipeline.vegetation.run({ property, building }, ctx)
  emit('vegetation')
  await sleep(delay, signal)
  throwIfAborted(signal)

  // 6. Terrain
  const terrain = pipeline.terrain.run({ property, building }, ctx)
  emit('terrain', terrain.confidence)
  await sleep(delay, signal)
  throwIfAborted(signal)

  const confidence = computeConfidence({ property, building, roof, terrain, vegetation, rng })

  return {
    origin: image.center,
    image,
    property,
    building,
    roof,
    terrain,
    vegetation,
    confidence,
    meta: { seed: image.seed, provider: provider.id, analyzedAt: new Date().toISOString() },
  }
}

/**
 * MapAnalysisEngine — a thin, configurable wrapper around {@link runAnalysis}
 * that carries a provider + pipeline so callers can hold one engine instance.
 */
export class MapAnalysisEngine {
  readonly provider: MapProvider
  readonly pipeline: DetectorPipeline

  constructor(config: { provider?: MapProvider; pipeline?: Partial<DetectorPipeline> } = {}) {
    this.provider = config.provider ?? defaultMapProvider
    this.pipeline = { ...defaultPipeline, ...config.pipeline }
  }

  analyze(input: AnalysisInput, opts: Omit<AnalyzeOptions, 'provider' | 'pipeline'> = {}): Promise<DetectedScene> {
    return runAnalysis(input, { ...opts, provider: this.provider, pipeline: this.pipeline })
  }
}
