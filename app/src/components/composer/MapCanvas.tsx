import { useCallback, useEffect, useRef } from 'react'
import type { GeoPoint, MapView } from '@/lib/composer'
import {
  geoToLocal,
  localToGeo,
  offsetGeo,
  spanForZoom,
  parcelsInBounds,
  SeededRng,
} from '@/lib/composer'
import { lonToTileX, latToTileY, tileGroundMeters } from '@/lib/composer/onlineProvider'
import type { ImageryLayer } from '@/lib/composer/imagery'

/**
 * MapCanvas — the interactive, offline "satellite" surface.
 *
 * Renders the deterministic synthetic aerial (parcels, streets, buildings,
 * greenery) with its own DPR-aware canvas, and handles pan / zoom / tap. What
 * the user taps is the geo-coordinate handed to the analysis engine, so the pin
 * always sits on the lot that gets turned into the twin. Pure presentation —
 * all state lives in the composer store.
 */

export interface MapCanvasProps {
  view: MapView
  pin: GeoPoint | null
  polygon: GeoPoint[]
  drawingPolygon: boolean
  onViewChange: (v: MapView) => void
  onTap: (p: GeoPoint) => void
  onAddPolygonPoint: (p: GeoPoint) => void
  className?: string
  /**
   * Real imagery, bottom layer first. The global layer is the base; a regional
   * orthophoto paints over it and shows the base through its transparency
   * wherever the survey does not reach. Null/absent → synthetic aerial.
   */
  imagery?: ImageryLayer[] | null
  /**
   * Welche Ebenen an dieser Stelle tatsächlich Pixel geliefert haben. Erst
   * damit darf die Oberfläche eine Quelle benennen.
   */
  onCoverage?: (covered: ReadonlySet<string>) => void
}

/**
 * Hat diese Kachel Inhalt, oder ist sie das transparente Nichts jenseits der
 * Landesgrenze? Acht mal acht Stichproben genügen: ein Luftbild ist überall
 * deckend, eine Lücke überall durchsichtig.
 *
 * Schlägt das Auslesen fehl — kein Canvas-Backend, CORS-Verweigerung —, gilt
 * die Kachel als vorhanden. Ein falsch gemeldeter Treffer kostet ein Etikett,
 * ein falsch gemeldeter Ausfall würde eine echte Quelle verschweigen.
 */
function hasPixels(img: HTMLImageElement): boolean {
  try {
    const probe = document.createElement('canvas')
    probe.width = 8
    probe.height = 8
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) return true
    ctx.drawImage(img, 0, 0, 8, 8)
    const { data } = ctx.getImageData(0, 0, 8, 8)
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) return true
    return false
  } catch {
    return true
  }
}

// ── Real-imagery tiles ─────────────────────────────────────────────
// Loaded tiles, cached across renders/mounts. The synthetic aerial stays
// underneath as the loading fallback; tiles paint over it as they arrive.
// The key carries the layer id — two sources share the same z/x/y grid, and
// without it the finer layer would be served the coarser layer's pixels.
interface ScreenTile { img: CanvasImageSource; x: number; y: number; s: number }
interface TileEntry { img: HTMLImageElement; ok: boolean; filled: boolean }
const tileCache = new Map<string, TileEntry>()

function collectTiles(
  view: MapView, w: number, h: number,
  layer: ImageryLayer,
  onLoaded: () => void,
  /** Wird gesetzt, sobald eine Kachel dieser Ebene Inhalt zeigt. */
  seen?: { filled: boolean },
): ScreenTile[] {
  const z = Math.max(3, Math.min(layer.maxZoom, Math.round(view.zoom)))
  const n = 2 ** z
  const groundM = tileGroundMeters(view.center.lat, z)
  const px = Math.min(w, h) / spanForZoom(view.zoom) // screen px per ground metre
  const s = groundM * px // tile edge on screen, px
  const cxT = lonToTileX(view.center.lng, z)
  const cyT = latToTileY(view.center.lat, z)
  const out: ScreenTile[] = []
  const rx = Math.ceil(w / 2 / s) + 1, ry = Math.ceil(h / 2 / s) + 1
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      const tx = Math.floor(cxT) + dx
      const ty = Math.floor(cyT) + dy
      if (ty < 0 || ty >= n) continue
      const wx = ((tx % n) + n) % n // wrap longitude
      const key = `${layer.id}/${z}/${wx}/${ty}`
      let entry = tileCache.get(key)
      if (!entry) {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        entry = { img, ok: false, filled: false }
        tileCache.set(key, entry)
        img.onload = () => {
          entry!.ok = true
          entry!.filled = layer.partial ? hasPixels(img) : true
          onLoaded()
        }
        img.src = layer.tileUrl(z, wx, ty)
      }
      if (entry.ok) {
        if (entry.filled && seen) seen.filled = true
        out.push({ img: entry.img, x: w / 2 + (tx - cxT) * s, y: h / 2 + (ty - cyT) * s, s })
      }
    }
  }
  return out
}

const MIN_ZOOM = 15
const MAX_ZOOM = 20

interface Proj {
  toScreen: (p: GeoPoint) => { x: number; y: number }
  toGeo: (x: number, y: number) => GeoPoint
  px: number
}

function makeProj(view: MapView, w: number, h: number): Proj {
  const px = Math.min(w, h) / spanForZoom(view.zoom)
  return {
    px,
    toScreen: (p) => {
      const local = geoToLocal(view.center, p)
      return { x: w / 2 + local.x * px, y: h / 2 + local.y * px }
    },
    toGeo: (x, y) => localToGeo(view.center, { x: (x - w / 2) / px, y: (y - h / 2) / px }),
  }
}

function drawAerial(
  ctx: CanvasRenderingContext2D,
  view: MapView,
  w: number,
  h: number,
  pin: GeoPoint | null,
  polygon: GeoPoint[],
  tiles: ScreenTile[] = [],
): void {
  const proj = makeProj(view, w, h)

  // Backdrop — a deep, calm ground tone.
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#12150f')
  bg.addColorStop(1, '#0d0f0a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // Which parcels are on screen? Pad the bounds by a lot so nothing pops in.
  const sw = proj.toGeo(-80, h + 80)
  const ne = proj.toGeo(w + 80, -80)
  const parcels = parcelsInBounds(sw, ne, view.center.lat, 260)

  const pinParcelSeed = pin ? parcelSeedAt(pin, view) : null

  // Streets first (drawn as the gaps between lots read as a subtle grid).
  ctx.lineWidth = Math.max(2, proj.px * 1.4)
  ctx.strokeStyle = 'rgba(150,150,140,0.10)'

  for (const parcel of parcels) {
    const rng = new SeededRng(parcel.seed)
    const originScreen = proj.toScreen(parcel.origin)
    const wPx = parcel.widthM * proj.px
    const dPx = parcel.depthM * proj.px

    // Lawn / lot base.
    const green = 44 + Math.floor(rng.range(-6, 10))
    ctx.fillStyle = parcel.built ? `rgb(${green - 6}, ${green + 16}, ${green - 18})` : `rgb(${green - 10}, ${green + 22}, ${green - 14})`
    ctx.fillRect(originScreen.x, originScreen.y, wPx, dPx)

    // Lot outline (soft).
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(originScreen.x, originScreen.y, wPx, dPx)

    if (!parcel.built) {
      // A few trees on an empty meadow.
      drawTrees(ctx, proj, parcel.origin, parcel.widthM, parcel.depthM, rng, 4)
      continue
    }

    // Building — a set-back block near the (southern) street front.
    const bw = parcel.widthM * rng.range(0.42, 0.6)
    const bd = parcel.depthM * rng.range(0.3, 0.42)
    const bx = (parcel.widthM - bw) / 2 + rng.range(-1, 1)
    const front = 5 + rng.range(0, 2)
    const by = parcel.depthM - front - bd
    const roof = rng.pick(['#6d6258', '#7a5a46', '#5f5b57', '#736452'])
    fillLocalRect(ctx, proj, parcel.origin, bx, by, bw, bd, roof)

    // Driveway from the street to the house front.
    const dwW = 3
    fillLocalRect(ctx, proj, parcel.origin, bx + bw / 2 - dwW / 2, by + bd, dwW, front, 'rgba(80,80,74,0.7)')

    // Pool on some lots.
    if (rng.bool(0.24)) {
      fillLocalRect(ctx, proj, parcel.origin, bx, by - 5, Math.min(bw, 6), 3.5, '#2f6f86')
    }
    drawTrees(ctx, proj, parcel.origin, parcel.widthM, parcel.depthM, rng, 3)

    // Highlight the tapped lot.
    if (pinParcelSeed !== null && parcel.seed === pinParcelSeed) {
      ctx.save()
      ctx.strokeStyle = 'rgba(232,200,121,0.9)'
      ctx.lineWidth = 2.5
      ctx.setLineDash([6, 4])
      ctx.strokeRect(originScreen.x, originScreen.y, wPx, dPx)
      ctx.restore()
    }
  }

  // Real satellite imagery — painted over the synthetic aerial (which stays
  // visible as the loading fallback), under the pin/polygon overlays.
  for (const t of tiles) ctx.drawImage(t.img, t.x, t.y, t.s + 0.6, t.s + 0.6)

  // User-drawn polygon.
  if (polygon.length > 0) {
    ctx.beginPath()
    polygon.forEach((p, i) => {
      const s = proj.toScreen(p)
      if (i === 0) ctx.moveTo(s.x, s.y)
      else ctx.lineTo(s.x, s.y)
    })
    if (polygon.length >= 3) ctx.closePath()
    ctx.fillStyle = 'rgba(232,200,121,0.12)'
    ctx.strokeStyle = 'rgba(232,200,121,0.9)'
    ctx.lineWidth = 2
    if (polygon.length >= 3) ctx.fill()
    ctx.stroke()
    for (const p of polygon) {
      const s = proj.toScreen(p)
      ctx.beginPath()
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#e8c879'
      ctx.fill()
    }
  }

  // Pin.
  if (pin) {
    const s = proj.toScreen(pin)
    ctx.save()
    ctx.shadowColor = 'rgba(232,200,121,0.6)'
    ctx.shadowBlur = 16
    // ring
    ctx.beginPath()
    ctx.arc(s.x, s.y, 14, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(232,200,121,0.85)'
    ctx.lineWidth = 2
    ctx.stroke()
    // dot
    ctx.beginPath()
    ctx.arc(s.x, s.y, 6, 0, Math.PI * 2)
    ctx.fillStyle = '#f0d68c'
    ctx.fill()
    ctx.restore()
  }

  // Gentle vignette for depth.
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, w, h)
}

function fillLocalRect(
  ctx: CanvasRenderingContext2D,
  proj: Proj,
  origin: GeoPoint,
  xM: number,
  yM: number,
  wM: number,
  dM: number,
  color: string,
): void {
  const a = proj.toScreen(offsetGeoLocal(origin, xM, yM))
  ctx.fillStyle = color
  ctx.fillRect(a.x, a.y, wM * proj.px, dM * proj.px)
}

function drawTrees(
  ctx: CanvasRenderingContext2D,
  proj: Proj,
  origin: GeoPoint,
  wM: number,
  dM: number,
  rng: SeededRng,
  n: number,
): void {
  for (let i = 0; i < n; i++) {
    const xM = rng.range(1, wM - 1)
    const yM = rng.range(1, dM * 0.5)
    const s = proj.toScreen(offsetGeoLocal(origin, xM, yM))
    const r = Math.max(2, rng.range(1.6, 3) * proj.px)
    ctx.beginPath()
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(38,58,32,0.9)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(s.x - r * 0.25, s.y - r * 0.25, r * 0.5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(70,96,52,0.8)'
    ctx.fill()
  }
}

/** Local-metre offset from a NW origin (x east, y south) → geo. */
function offsetGeoLocal(origin: GeoPoint, xM: number, yM: number): GeoPoint {
  return offsetGeo(origin, -yM, xM)
}

function parcelSeedAt(pin: GeoPoint, _view: MapView): number {
  // Re-derive the parcel seed for the pin so the highlight matches the analysis.
  const parcels = parcelsInBounds(offsetGeo(pin, -1, -1), offsetGeo(pin, 1, 1), pin.lat, 4)
  // The parcel containing the pin is the one whose origin is north-west of it
  // and within one lot — parcelsInBounds includes it; pick the nearest centre.
  let best = parcels[0]
  let bestD = Infinity
  for (const p of parcels) {
    const d = Math.hypot(p.center.lat - pin.lat, p.center.lng - pin.lng)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best?.seed ?? 0
}

export function MapCanvas({
  view,
  pin,
  polygon,
  drawingPolygon,
  onViewChange,
  onTap,
  onAddPolygonPoint,
  className,
  imagery,
  onCoverage,
}: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const dragRef = useRef<{ x: number; y: number; moved: boolean; t: number } | null>(null)
  // Tile onload fires after this render pass — repaint through the latest render.
  const renderRef = useRef<() => void>(() => {})

  // Der Deckungsbericht läuft über eine Referenz: so muss `render` nicht bei
  // jedem neuen Callback des Elternteils neu gebaut werden. Gemeldet wird nur
  // eine echte Änderung — sonst löste jedes Zeichnen einen Zustandswechsel aus,
  // der sofort wieder zeichnen ließe.
  const lastCoverage = useRef('')
  const onCoverageRef = useRef(onCoverage)
  onCoverageRef.current = onCoverage
  const coverageRef = useRef((covered: ReadonlySet<string>) => {
    const key = [...covered].sort().join('|')
    if (key === lastCoverage.current) return
    lastCoverage.current = key
    onCoverageRef.current?.(covered)
  })

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // getContext throws in headless/jsdom environments without a canvas backend.
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    // One pass per layer, bottom first — the stack is the drawing order.
    const covered = new Set<string>()
    const tiles = (imagery ?? []).flatMap((layer) => {
      const seen = { filled: false }
      const got = collectTiles(view, w, h, layer, () => renderRef.current(), seen)
      if (seen.filled) covered.add(layer.id)
      return got
    })
    coverageRef.current(covered)
    ctx.save()
    ctx.scale(canvas.width / w, canvas.height / h)
    drawAerial(ctx, view, w, h, pin, polygon, tiles)
    ctx.restore()
  }, [view, pin, polygon, imagery])
  renderRef.current = render

  // Size + DPR handling.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => {
      const rect = parent.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      sizeRef.current = { w: rect.width, h: rect.height }
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      render()
    })
    ro.observe(parent)
    return () => ro.disconnect()
  }, [render])

  useEffect(() => {
    render()
  }, [render])

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    target.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false, t: Date.now() }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    if (!drag.moved) return
    const { w, h } = sizeRef.current
    const px = Math.min(w, h) / spanForZoom(view.zoom)
    onViewChange({ ...view, center: offsetGeo(view.center, dy / px, -dx / px) })
    drag.x = e.clientX
    drag.y = e.clientY
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    if (drag.moved || Date.now() - drag.t > 500) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const { w, h } = sizeRef.current
    const proj = makeProj(view, w, h)
    const geo = proj.toGeo(e.clientX - rect.left, e.clientY - rect.top)
    if (drawingPolygon) onAddPolygonPoint(geo)
    else onTap(geo)
  }

  const onWheel = (e: React.WheelEvent) => {
    const dir = e.deltaY > 0 ? -1 : 1
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom + dir))
    if (zoom !== view.zoom) onViewChange({ ...view, zoom })
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ touchAction: 'none', cursor: drawingPolygon ? 'crosshair' : 'grab', display: 'block' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    />
  )
}
