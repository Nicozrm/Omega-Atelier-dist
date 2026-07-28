import type { Provenance, SourceRef } from './provenance'
import type { LocalFrame } from './frame'
import type {
  NeighbourhoodSummary, OsmBuilding, OsmPoi, OsmRoad,
} from './resolvers/osmResolver'

/**
 * types.ts — the Composer's shared vocabulary.
 *
 * The address→twin pipeline is a chain of swappable detector modules, so the
 * data passed between them is defined once, here, and nowhere else. Two frames
 * of reference appear throughout:
 *
 *   • **geo** — WGS84 degrees ({@link GeoPoint}), how the world is addressed.
 *   • **local** — metres from the parcel's NW corner ({@link LocalPoint}),
 *     x → east, y → south, matching the editor's plan axes.
 *
 * Types only: no runtime, no renderer, no map-provider dependency.
 */

/* ────────────────────────────── Frames ──────────────────────────────── */

export interface GeoPoint {
  lat: number
  lng: number
}

/** A point in the local metric frame (metres from the parcel's NW corner). */
export interface LocalPoint {
  x: number
  y: number
}

export type LocalPolygon = LocalPoint[]

/** What the map is currently showing. */
export interface MapView {
  center: GeoPoint
  /** Web-mercator zoom level. */
  zoom: number
}

/** One geocoding hit. */
export interface GeoResult {
  label: string
  point: GeoPoint
  /** Where the hit came from — drives how much the UI trusts it. */
  source: 'coordinate' | 'gazetteer' | 'synthetic' | 'online'
  /** 0…1. */
  confidence: number
}

/* ────────────────────────────── Randomness ──────────────────────────── */

/**
 * The deterministic random source every detector draws from. Implemented by
 * `SeededRng`; declared here so modules depend on the contract, not the class.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform in [min, max). */
  range(min: number, max: number): number
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number
  /** True with probability `p`. */
  bool(p?: number): boolean
  /** Uniformly pick one element. */
  pick<T>(items: readonly T[]): T
  /** Gaussian sample. */
  gaussian(mean?: number, sd?: number): number
  /** An independent child stream, so one module's draws never shift another's. */
  fork(salt: number): Rng
}

/* ────────────────────────────── Pipeline ────────────────────────────── */

/** The analysable patch a MapProvider hands to the pipeline. */
export interface SatelliteImage {
  /** Centre of the captured patch — the local frame's anchor. */
  center: GeoPoint
  /** Ground covered edge-to-edge, metres. */
  spanMeters: number
  /** Deterministic seed for everything derived from this patch. */
  seed: number
  metersPerPixel: number
  /** Id of the provider that captured it. */
  provider: string
  capturedAt: string
}

/** Everything a detector may read besides its own input. */
export interface AnalysisContext {
  rng: Rng
  image: SatelliteImage
  /** Der lokale metrische Rahmen — alle Quellen projizieren hier hinein. */
  frame: LocalFrame
  /**
   * Was OpenStreetMap zum Standort weiß, bereits projiziert und sortiert.
   * Fehlt, wenn die Quelle nicht erreichbar war — dann bleibt der Generator
   * zuständig und markiert seine Ausgabe als Annahme.
   */
  osm?: OsmObservations
  /**
   * The parcel the user drew, already projected into the local metric frame,
   * rotated into its own axes and normalised to start at the origin.
   *
   * Present only when the user actually drew one. This is the single most
   * reliable input the pipeline ever gets — it is the one thing the person in
   * front of the screen knows better than any data source — so detectors must
   * prefer it over anything they could derive themselves.
   */
  parcel?: ParcelInput
}

/** Was aus der OSM-Antwort für die Detektoren übrig bleibt. */
export interface OsmObservations {
  buildings: OsmBuilding[]
  /** Das Gebäude, das als „das eigene" gilt — sofern erfasst. */
  own?: OsmBuilding
  roads: OsmRoad[]
  pois: OsmPoi[]
  summary: NeighbourhoodSummary
  /** Datenstand und Abrufzeit, für die Quellenangabe. */
  source: SourceRef
}

/** The user-drawn parcel, prepared for the detectors. */
export interface ParcelInput {
  /** Outline in local metres, bounding box anchored at (0, 0). */
  polygon: LocalPolygon
  /** True area by the shoelace formula — not the bounding box's. */
  areaSqm: number
  /** Extent along the parcel's own axes. */
  widthM: number
  depthM: number
  /** Rotation of those axes against north, degrees. */
  orientationDeg: number
}

/** A swappable pipeline step. */
export interface DetectorModule<In, Out> {
  id: string
  label: string
  run(input: In, ctx: AnalysisContext): Out
}

/** The phases a run reports, in order. */
export type PhaseId =
  | 'satellite'
  | 'property'
  | 'building'
  | 'roof'
  | 'vegetation'
  | 'terrain'
  | 'scene'
  | 'project'

export interface AnalysisProgress {
  phase: PhaseId
  /** 1-based position of this phase. */
  index: number
  total: number
  label: string
  /** The phase's own confidence, where it produces one. */
  confidence?: number
  detail?: string
}

export type AnalysisStatus = 'idle' | 'running' | 'done' | 'canceled' | 'error'

/* ────────────────────────────── Features ────────────────────────────── */

/** The parcel, as an axis-aligned rectangle in the local frame. */
export interface PropertyFeature {
  polygon: LocalPolygon
  areaSqm: number
  widthM: number
  depthM: number
  /** Long-axis rotation against north, degrees. */
  orientationDeg: number
  /** Which edge the street runs along. */
  streetSide: 'south' | 'north' | 'east' | 'west'
  confidence: number
  /**
   * Where the geometry came from. `user` once the parcel was drawn, `assumed`
   * while the synthetic fallback is in play. The street side stays `assumed`
   * either way until a road source (OSM) can answer it.
   */
  provenance: {
    geometry: Provenance
    streetSide: Provenance
  }
  /** Name der erschließenden Straße, sofern erfasst. */
  streetName?: string
}

/** One volume of the building — the house itself or an attachment. */
export interface BuildingPart {
  kind: 'main' | 'garage' | 'carport' | 'extension' | 'terrace' | 'conservatory' | 'balcony'
  polygon: LocalPolygon
  /** Height above ground, metres. 0 for a flat slab (terrace). */
  heightM: number
  confidence: number
}

export interface BuildingFeature {
  /** The main volume's outline. */
  footprint: LocalPolygon
  parts: BuildingPart[]
  /** Eaves height of the main volume, metres. */
  heightM: number
  stories: number
  areaSqm: number
  confidence: number
  /**
   * Herkunft je Aussage. Bewusst getrennt: der Umriss kann gemessen sein,
   * während die Geschosszahl nur abgeleitet und die Traufhöhe geschätzt ist —
   * ein einziger Wert für „das Gebäude" würde genau das verwischen.
   */
  provenance: {
    footprint: Provenance
    stories: Provenance
    height: Provenance
  }
}

export type RoofShape = 'gable' | 'hip' | 'flat' | 'pent'

export interface RoofFeature {
  shape: RoofShape
  pitchDeg: number
  ridgeHeightM: number
  eavesHeightM: number
  /** Ridge bearing, degrees — 0 = north–south. */
  orientationDeg: number
  confidence: number
  /**
   * Woher die Dachform stammt. Die Neigung bleibt auch bei getaggter Form eine
   * Ableitung — OSM kennt sie praktisch nie, LoD2 wird sie liefern.
   */
  shapeProvenance: Provenance
}

/** A run of entrance steps on the driveway/path. */
export interface TerrainStep {
  at: LocalPoint
  count: number
  /** Rise per step, metres. */
  riseM: number
}

export interface TerrainProfile {
  slopeDeg: number
  /** Downhill bearing, degrees. */
  aspectDeg: number
  elevationDropM: number
  /** Driveway centre-line, street → house. */
  drivewayPath: LocalPolygon
  steps: TerrainStep[]
  confidence: number
}

export interface PlantItem {
  at: LocalPoint
  /** Canopy radius, metres. */
  radiusM: number
  kind: 'tree' | 'shrub'
  confidence: number
}

export interface HedgeItem {
  path: LocalPolygon
  heightM: number
  confidence: number
}

export interface LawnItem {
  polygon: LocalPolygon
  areaSqm: number
}

export interface PoolItem {
  polygon: LocalPolygon
  areaSqm: number
  confidence: number
}

export interface VegetationFeature {
  plants: PlantItem[]
  hedges: HedgeItem[]
  lawns: LawnItem[]
  pools: PoolItem[]
}

/* ────────────────────────────── Confidence ──────────────────────────── */

/** The canonical objects the confidence report scores. */
export type ConfidenceKey =
  | 'property'
  | 'building'
  | 'roof'
  | 'garage'
  | 'terrain'
  | 'vegetation'
  | 'interior'

export interface ConfidenceReport {
  /** Weighted overall score, 0…1. Derived from provenance, never estimated. */
  overall: number
  byObject: Record<ConfidenceKey, number>
  /** Why each score is what it is — what the UI shows next to the bar. */
  provenance: Record<ConfidenceKey, Provenance>
}

/* ────────────────────────────── Result ──────────────────────────────── */

/** Everything one analysis run produced. */
export interface DetectedScene {
  /** The local frame's geo anchor (the captured patch's centre). */
  origin: GeoPoint
  image: SatelliteImage
  property: PropertyFeature
  building: BuildingFeature
  roof: RoofFeature
  terrain: TerrainProfile
  vegetation: VegetationFeature
  confidence: ConfidenceReport
  meta: {
    seed: number
    provider: string
    analyzedAt: string
  }
}
