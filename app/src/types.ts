/**
 * types.ts — the Omega plan model.
 *
 * The shared vocabulary of the whole app: a plan is a document of floors, each
 * floor a set of walls, rooms, placed devices, placed furniture, labels and
 * Image-Blaster assets, plus the catalog entries those placements reference.
 * Pure types — no runtime, no renderer, no vendor concept — so every layer
 * (editor, 3D, connectors, persistence) speaks the same shapes.
 *
 * Units: plan coordinates are **centimetres**, origin top-left, x → east,
 * y → south. The 3D view converts to metres at its boundary.
 */

export type UUID = string

export interface Point {
  x: number
  y: number
}

/* ────────────────────────────── Structure ────────────────────────────── */

/** What a wall segment represents. A plain `wall` is solid. */
export type WallSubtype = 'wall' | 'window' | 'door'

export interface Wall {
  id: UUID
  a: Point
  b: Point
  /** Wall thickness in cm. */
  thickness: number
  /** Wall height in cm. Defaults to the storey height when absent. */
  height?: number
  subtype?: WallSubtype
  /** Opening geometry in cm — only meaningful for `window` / `door`. */
  openingWidth?: number
  openingHeight?: number
  openingSill?: number
  materialId?: string
}

/** Coarse room role — drives defaults for materials, furnishing and lighting. */
export type RoomZone = 'indoor' | 'outdoor' | 'wet' | 'technical'

export interface Room {
  id: UUID
  name: string
  polygon: Point[]
  zoneType?: RoomZone
  floorMaterialId?: string
  wallMaterialId?: string
  ceilingMaterialId?: string
  /** Legacy per-room floor variant, superseded by `floorMaterialId`. */
  floorVariant?: string
  /** Legacy per-room wall variant, superseded by `wallMaterialId`. */
  wallVariant?: string
  color?: string
}

/* ────────────────────────────── Placements ───────────────────────────── */

/**
 * Per-mode desired state of a placed device (the Omega mode matrix).
 *
 * Deliberately an open record rather than a closed shape: what a device
 * exposes depends on its category, and the core must not enumerate vendor
 * features. The conventional keys are `on` (boolean), `brightness` /
 * `position` (0–100), `kelvin`, `temperature` and `color` (hex string).
 */
export type DeviceModeState = Record<string, string | number | boolean>

export interface PlacedDevice {
  id: UUID
  /** References `DeviceCatalogEntry.id`. */
  deviceId: string
  position: Point
  /** Degrees, clockwise. */
  rotation?: number
  roomId?: UUID
  note?: string
  /** Mounting height in cm above the floor. */
  elevation?: number
  /** Desired state per Omega mode. Missing modes fall back to "off". */
  modeState?: Partial<Record<ModeKey, DeviceModeState>>
}

export interface PlacedFurniture {
  id: UUID
  /** References `FurnitureCatalogEntry.id`. */
  furnitureId: string
  position: Point
  rotation?: number
  roomId?: UUID
  /** Footprint override `[width, depth]` in cm — falls back to the catalog size. */
  size?: [number, number]
  /** Free-text label drawn next to the piece. */
  label?: string
  /** Material-slot choice (see lib/materialSlots). */
  materialKey?: string
  color?: string
  note?: string
  /** Hidden pieces stay in the document but are not drawn. */
  hidden?: boolean
  /** Locked pieces cannot be moved by dragging. */
  locked?: boolean
}

export interface Label {
  id: UUID
  position: Point
  text: string
  rotation?: number
  fontSize?: number
  /** Rendered text size in px. */
  size?: number
  color?: string
  hidden?: boolean
}

/** Where an Image-Blaster asset hangs. */
export type BlasterMount = 'wall' | 'floor'

export interface PlacedBlasterAsset {
  id: UUID
  name: string
  /** Source image as a `data:image/*` URL — assets are self-contained. */
  image: string
  /** The generation recipe (see lib/imageBlaster/settingsSchema). */
  settings: Record<string, unknown>
  position: Point
  rotation: number
  /** Rendered width in cm. */
  width: number
  /** Height above the floor in cm. */
  elevation: number
  mount: BlasterMount
  roomId?: UUID
  hidden?: boolean
}

/* ────────────────────────────── Floors ───────────────────────────────── */

export type LayerKey = 'walls' | 'furniture' | 'devices' | 'labels'

export interface Floor {
  id: UUID
  name: string
  /** Storey index — 0 is ground level, negative is basement. */
  index: number
  walls: Wall[]
  rooms: Room[]
  devices: PlacedDevice[]
  furniture: PlacedFurniture[]
  labels: Label[]
  /** Image-Blaster assets. Absent on floors created before the feature. */
  blasterAssets?: PlacedBlasterAsset[]
  layers: Record<LayerKey, boolean>
  /** Canvas extent in cm. */
  extent: { width: number; height: number }
}

/* ────────────────────────────── Modes ────────────────────────────────── */

export type ModeKey =
  | 'auto'
  | 'morning'
  | 'day-office'
  | 'film'
  | 'night'
  | 'relax'
  | 'away'
  | 'party'
  | 'alarm'

export interface ModeTrigger {
  manual?: boolean
  presence?: 'any' | 'home' | 'away'
  /** `HH:MM` window. */
  time?: { from: string; to: string }
}

export interface OmegaMode {
  key: ModeKey
  name: string
  description: string
  /** lucide-react icon name. */
  icon: string
  accent: string
  trigger: ModeTrigger
  /** Categories a plan needs for this mode to be considered ready. */
  requiredCategories: DeviceCategory[]
}

/* ────────────────────────────── Catalogs ────────────────────────────── */

export type DeviceCategory =
  | 'light'
  | 'switch'
  | 'outlet'
  | 'sensor'
  | 'climate'
  | 'blind'
  | 'lock'
  | 'camera'
  | 'speaker'
  | 'tv'
  | 'hub'
  | 'appliance'
  | 'alarm'
  | 'irrigation'
  | 'other'

export type Ecosystem =
  | 'philips-hue'
  | 'hue-secure'
  | 'hue-sync'
  | 'apple-home'
  | 'google-home'
  | 'alexa'
  | 'samsung-smartthings'
  | 'home-assistant'
  | 'homey'
  | 'ikea-dirigera'
  | 'aqara'
  | 'shelly'
  | 'sonos'
  | 'eve'
  | 'netatmo'
  | 'nuki'
  | 'lockin'
  | 'bosch-sh'
  | 'tado'
  | 'govee'
  | 'switchbot'
  | 'smart-life'
  | 'tuya'
  | 'loxone'
  | 'lutron'
  | 'fibaro'
  | 'fritzbox'
  | 'arenti'
  | 'osaio'
  | 'kindermatte'
  | 'matter'
  | 'custom'

export type DeviceProtocol =
  | 'zigbee'
  | 'z-wave'
  | 'wifi'
  | 'thread'
  | 'matter'
  | 'bt'
  | 'wired'

export interface DeviceCatalogEntry {
  id: string
  name: string
  brand: string
  ecosystem: Ecosystem
  category: DeviceCategory
  protocol: DeviceProtocol[]
  /** EUR, indicative. */
  price?: number
  /** Watts, indicative continuous draw. */
  power?: number
  /** lucide-react icon name. */
  icon: string
  /** Modes this device typically participates in. */
  modeTags: ModeKey[]
  /** Catalog ids this device needs to work (e.g. its bridge). */
  requires?: string[]
  /** Free-form search/filter tags. */
  tags?: string[]
}

export type FurnitureCategory =
  | 'sofa'
  | 'chair'
  | 'bed'
  | 'table'
  | 'storage'
  | 'kitchen'
  | 'bath'
  | 'decor'
  | 'outdoor'
  | 'other'

export interface FurnitureCatalogEntry {
  id: string
  name: string
  category: FurnitureCategory
  /** Footprint `[width, depth]` in cm. */
  size: [number, number]
  /** Height in cm, where it matters for 3D. */
  height?: number
  icon?: string
}

/* ────────────────────────────── Document ────────────────────────────── */

export interface PlanSettings {
  unit: 'cm' | 'm'
  gridSize: number
  snap: boolean
  snapStep: number
  showGrid: boolean
  magnet?: boolean
  theme: 'dark' | 'light'
}

export interface PlanDocument {
  schemaVersion: number
  id: UUID
  title: string
  description?: string
  floors: Floor[]
  activeFloorId: UUID
  activeModeKey: ModeKey
  modes: OmegaMode[]
  settings: PlanSettings
  createdAt: string
  updatedAt: string
  tags?: string[]
  /**
   * Id of the tab that last wrote this document. Realtime uses it to tell an
   * echo of our own write apart from a genuine remote edit.
   */
  clientId?: string
  /** Monotonic write counter — the cloud save's optimistic-concurrency guard. */
  docVersion?: number
  /**
   * Where this plan sits in the real world, when it came from the Composer
   * (address search → satellite analysis). Drives the sun position, the
   * regional building style and the generated neighbourhood.
   */
  geo?: PlanGeo
}

/** Real-world anchoring for a plan. */
export interface PlanGeo {
  lat: number
  lng: number
  /** Human-readable place label, e.g. "Kolpingstraße 12, Rheine". */
  label?: string
  /** Building rotation against true north, degrees. */
  orientationDeg?: number
}

/* ────────────────────────────── Editor UI ───────────────────────────── */

export type Tool =
  | 'select'
  | 'wall'
  | 'door'
  | 'window'
  | 'terrace'
  | 'device'
  | 'furniture'
  | 'label'
  | 'measure'
  | 'room'
  | 'pan'

export type SelectionKind = 'wall' | 'room' | 'device' | 'furniture' | 'label' | 'blaster'

/**
 * The editor's current selection: one kind at a time, any number of ids.
 * `type: null` (with an empty `ids`) is the cleared selection.
 */
export interface Selection {
  type: SelectionKind | null
  ids: UUID[]
}

export interface Viewport {
  /** Screen pixels per cm. */
  zoom: number
  /** Pan offset in screen pixels. */
  offsetX: number
  offsetY: number
}

/* ────────────────────────────── Collaboration ───────────────────────── */

export type CollaboratorRole = 'owner' | 'editor' | 'viewer'

/** A peer's live cursor, broadcast over the realtime channel. */
export interface RemoteCursor {
  userId: string
  name: string
  color: string
  /** Plan coordinates in cm. */
  x: number
  y: number
  /** The floor the peer is looking at — cursors only show on their own floor. */
  floorId: UUID
  tool: Tool
  /** Client timestamp (ms) of the sample. */
  ts: number
}

/** The `plans` table row as stored in Supabase. */
export interface PlanRow {
  id: UUID
  owner_id: string
  title: string
  doc: PlanDocument
  is_public: boolean
  created_at: string
  updated_at: string
}
