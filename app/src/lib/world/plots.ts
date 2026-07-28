/**
 * plots.ts — block subdivision and what stands on each plot.
 *
 * A block's frontage is divided into plots the way a surveyor would: plots face
 * the street, run back to the middle of the block, and vary in width within the
 * range the region considers normal. Corner plots get the extra width they have
 * in reality, and the plot holding the user's own plan is reserved so the real
 * building never collides with a generated one.
 *
 * Each residential plot then resolves to a {@link HouseSpec} — a complete,
 * renderer-neutral description of the building, its garage, its boundary and
 * its garden. The renderer turns that into meshes and never makes a layout
 * decision of its own, which is what lets the same world drive traffic,
 * pedestrians and (later) shadow or energy studies.
 */

import { cityStyleSpec, pickWeighted, type BoundaryKind, type CityStyle, type RoofForm, type TreeKind } from './cityStyle'
import { SeededRng, hashInts } from '@/lib/composer/rng'
import type { Block, StreetNetwork, Vec2 } from './streetNetwork'

/** Which side of the block a plot fronts onto. */
export type Frontage = 'north' | 'south'

export type PlotUse = 'house' | 'amenity' | 'green' | 'reserved'

export interface Plot {
  id: string
  blockId: string
  /** Plot centre in world metres. */
  centre: Vec2
  widthM: number
  depthM: number
  /** Which edge the street is on. */
  frontage: Frontage
  /** Y rotation that makes the building face its street. */
  rotationY: number
  /** Signed z offset from the plot centre to the street edge. */
  frontSign: 1 | -1
  use: PlotUse
  corner: boolean
  /** Deterministic seed for everything this plot grows. */
  seed: number
}

export interface GardenFeature {
  kind: 'terrace' | 'trampoline' | 'pool' | 'shed' | 'vegetable' | 'washing'
  /** Offset from the plot centre, metres. */
  at: Vec2
  rotationY: number
}

export interface TreeSpec {
  kind: TreeKind
  /** Offset from the plot centre, metres. */
  at: Vec2
  /** Overall scale multiplier. */
  scale: number
}

/**
 * Render budget for one building.
 *
 * A generated estate reaches a few hundred houses, and every one of them at
 * full trim would cost more than the plan itself. Detail therefore falls off
 * with distance from the user's own plot, which is also where the camera almost
 * always looks: `full` carries gutters, dormers, bins and garden props;
 * `simple` keeps the massing, roof and windows; `massing` is body plus roof,
 * which at that distance is all the silhouette shows anyway.
 */
export type HouseLod = 'full' | 'simple' | 'massing'

export interface HouseSpec {
  plot: Plot
  lod: HouseLod
  /** Straight-line distance from the plan centre, metres. */
  distanceM: number
  /**
   * The **building's** centre in world metres — not the plot's.
   *
   * A house is never centred on its plot: it stands the region's setback back
   * from the property line, which puts a short front garden between it and the
   * pavement and leaves the rest of the depth as back garden. Centring it
   * instead is the single thing that makes a generated estate read as a model
   * railway rather than a street.
   */
  centre: Vec2
  /** Depth of the front garden, house face to property line. */
  frontYardM: number
  /** Depth of the back garden, house back to rear boundary. */
  backYardM: number
  /** Footprint, metres. */
  widthM: number
  depthM: number
  stories: number
  /** Eaves height. */
  heightM: number
  roof: RoofForm
  roofPitchDeg: number
  /** Index into the style palette's facade list. */
  facadeIndex: number
  roofIndex: number
  chimney: boolean
  solar: boolean
  balcony: boolean
  dormer: boolean
  /** Attached to the neighbour on this side (terraced / semi-detached). */
  attached: 'none' | 'left' | 'right' | 'both'
  garage: 'none' | 'garage' | 'carport'
  /** Garage offset along the frontage from the house centre. */
  garageOffsetM: number
  driveLengthM: number
  /** A parked car on the drive. */
  parkedCar: boolean
  carColorIndex: number
  boundary: BoundaryKind
  /** Wheelie bins at the kerb. */
  bins: number
  /** Letterbox at the property line. */
  letterbox: boolean
  bikeRack: boolean
  trees: TreeSpec[]
  garden: GardenFeature[]
  /** Per-window lit state at night, indexed by the renderer's window order. */
  windowSeed: number
}

export interface PlotInput {
  style: CityStyle
  network: StreetNetwork
  seed: number
  /** Half-extents of the user's own plan, metres — that footprint is reserved. */
  ownHalfW: number
  ownHalfD: number
}

/**
 * Subdivide every block into plots. Blocks flagged by the caller (the local
 * centre, the park) are handed back with `use` set accordingly so the amenity
 * pass can claim them.
 */
export function subdividePlots(
  input: PlotInput,
  blockUse: Map<string, PlotUse>,
): Plot[] {
  const spec = cityStyleSpec(input.style)
  const [minW, maxW] = spec.block.plotWidthM
  const out: Plot[] = []
  const { centre } = input.network

  for (const block of input.network.blocks) {
    const use = blockUse.get(block.id) ?? 'house'
    const blockW = block.maxX - block.minX
    const blockD = block.maxZ - block.minZ
    if (blockW < minW || blockD < 8) continue

    // Green and amenity blocks are not subdivided — they are handled whole.
    if (use === 'green' || use === 'amenity') {
      out.push({
        id: `${block.id}-whole`, blockId: block.id,
        centre: { x: (block.minX + block.maxX) / 2, z: (block.minZ + block.maxZ) / 2 },
        widthM: blockW, depthM: blockD, frontage: 'north', rotationY: 0, frontSign: -1,
        use, corner: false, seed: hashInts(input.seed, block.gi, block.gj, 0x424c4b),
      })
      continue
    }

    const plotDepth = blockD / 2

    for (const frontage of ['north', 'south'] as Frontage[]) {
      const rng = new SeededRng(hashInts(input.seed, block.gi, block.gj, frontage === 'north' ? 1 : 2))
      // Fit a whole number of plots across the frontage, then distribute the
      // rounding slack so the row exactly fills the block — no leftover gap.
      const target = rng.range(minW, maxW)
      const count = Math.max(1, Math.round(blockW / target))
      const base = blockW / count

      for (let k = 0; k < count; k++) {
        const jitter = rng.range(-0.12, 0.12)
        const widthM = base * (1 + jitter)
        // Re-centre each plot on its nominal slot; the jitter only shifts the
        // building within its own frontage, never past its neighbour.
        const cxPlot = block.minX + base * (k + 0.5)
        const corner = k === 0 || k === count - 1
        const frontSign: 1 | -1 = frontage === 'north' ? -1 : 1
        const cz = frontage === 'north'
          ? block.minZ + plotDepth / 2
          : block.maxZ - plotDepth / 2

        // Reserve whatever overlaps the user's own building footprint.
        const overlapsOwn =
          Math.abs(cxPlot - centre.x) < input.ownHalfW + widthM / 2 + 3 &&
          Math.abs(cz - centre.z) < input.ownHalfD + plotDepth / 2 + 3

        out.push({
          id: `${block.id}-${frontage}-${k}`,
          blockId: block.id,
          centre: { x: cxPlot, z: cz },
          widthM, depthM: plotDepth,
          frontage,
          // North-fronting plots look toward −z; south-fronting toward +z.
          rotationY: frontage === 'north' ? Math.PI : 0,
          frontSign,
          use: overlapsOwn ? 'reserved' : 'house',
          corner,
          seed: hashInts(input.seed, block.gi, block.gj, k, frontage === 'north' ? 7 : 11),
        })
      }
    }
  }
  return out
}

/**
 * Resolve what stands on a residential plot. Everything is drawn from the plot's
 * own seed, so a plot's house never changes when a neighbouring block does.
 */
export function houseForPlot(plot: Plot, style: CityStyle, lodInput?: { centre: Vec2; fullM: number; simpleM: number }): HouseSpec {
  const spec = cityStyleSpec(style)
  const rng = new SeededRng(plot.seed)
  const b = spec.building

  const stories = rng.int(b.stories[0], b.stories[1])
  const heightM = stories * b.storeyHeightM
  const roof = pickWeighted<RoofForm>(b.roofWeights, rng.next())
  const roofPitchDeg = roof === 'flat' ? 2 : roof === 'pent' ? rng.range(10, 18) : rng.range(30, 45)

  // Footprint: as wide as the plot allows minus the side setbacks the region
  // keeps, and deep enough to be a house rather than a shed.
  const sideGap = plot.corner ? 3.2 : 2.4
  const maxWidth = Math.max(6, plot.widthM - sideGap * 2)
  const widthM = Math.min(maxWidth, rng.range(8, 13.5))
  const usableDepth = plot.depthM - spec.block.setbackM - 3
  const depthM = Math.max(6.5, Math.min(usableDepth, rng.range(8.5, 12)))

  const attachedRoll = rng.next()
  const attached: HouseSpec['attached'] =
    attachedRoll > b.attachedRatio ? 'none'
      : attachedRoll < b.attachedRatio * 0.35 ? 'both'
        : attachedRoll < b.attachedRatio * 0.68 ? 'left' : 'right'

  const garageRoll = rng.next()
  const garageFits = plot.widthM - widthM > 7
  const garage: HouseSpec['garage'] =
    !garageFits || attached === 'both' ? 'none'
      : garageRoll < spec.block.garageRatio * 0.72 ? 'garage'
        : garageRoll < spec.block.garageRatio ? 'carport' : 'none'
  const garageSide = rng.bool() ? 1 : -1
  const garageOffsetM = garageSide * (widthM / 2 + 2.1)

  const boundary = pickWeighted<BoundaryKind>(spec.vegetation.boundaryWeights, rng.next())

  // Garden trees sit beside and behind the house, never inside its footprint.
  const trees: TreeSpec[] = []
  const treeCount = rng.next() < spec.vegetation.gardenTreeRatio ? rng.int(1, 3) : 0
  for (let i = 0; i < treeCount; i++) {
    const side = rng.bool() ? 1 : -1
    trees.push({
      kind: pickWeighted<TreeKind>(spec.vegetation.treeWeights, rng.next()),
      at: {
        x: side * (widthM / 2 + rng.range(1.2, 2.6)),
        z: rng.range(-plot.depthM * 0.34, plot.depthM * 0.22),
      },
      scale: rng.range(0.85, 1.45),
    })
  }

  // Back garden. The features are the ones that read from the air and say
  // "someone lives here" — a terrace, a trampoline, washing on the line.
  const garden: GardenFeature[] = []
  const backRoom = plot.depthM - Math.min(spec.block.setbackM, plot.depthM / 2 - depthM / 2 - 1) - depthM
  if (backRoom > 3) {
    if (rng.bool(0.75)) garden.push({ kind: 'terrace', at: { x: rng.range(-1.5, 1.5), z: -(depthM / 2 + 1.6) }, rotationY: 0 })
    if (rng.bool(0.3)) garden.push({ kind: 'trampoline', at: { x: rng.range(-3, 3), z: -(depthM / 2 + rng.range(3, 4.5)) }, rotationY: 0 })
    if (rng.bool(0.22)) garden.push({ kind: 'shed', at: { x: (rng.bool() ? 1 : -1) * (widthM / 2 - 0.5), z: -(plot.depthM / 2 - 1.8) }, rotationY: rng.range(-0.3, 0.3) })
    if (rng.bool(0.28)) garden.push({ kind: 'washing', at: { x: rng.range(-2.5, 2.5), z: -(depthM / 2 + rng.range(2, 3.4)) }, rotationY: rng.range(-0.4, 0.4) })
    if (rng.bool(0.18)) garden.push({ kind: 'vegetable', at: { x: rng.range(-3, 3), z: -(plot.depthM / 2 - 3) }, rotationY: 0 })
    if (rng.bool(style === 'med' || style === 'us' ? 0.2 : 0.05) && backRoom > 6) {
      garden.push({ kind: 'pool', at: { x: rng.range(-2, 2), z: -(depthM / 2 + 4) }, rotationY: 0 })
    }
  }

  // Push the building forward to the region's setback. The plot's street edge
  // is `plot.depthM / 2` from its centre in the `frontSign` direction; the
  // house front then sits `setback` behind that edge.
  const frontYardM = Math.max(1.2, Math.min(spec.block.setbackM, plot.depthM / 2 - depthM / 2 - 1))
  const shift = plot.depthM / 2 - frontYardM - depthM / 2
  const centre: Vec2 = { x: plot.centre.x, z: plot.centre.z + plot.frontSign * shift }
  const backYardM = plot.depthM - frontYardM - depthM

  const distanceM = lodInput
    ? Math.hypot(centre.x - lodInput.centre.x, centre.z - lodInput.centre.z)
    : 0
  const lod: HouseLod = !lodInput || distanceM <= lodInput.fullM
    ? 'full'
    : distanceM <= lodInput.simpleM ? 'simple' : 'massing'

  return {
    plot, lod, distanceM, centre, frontYardM, backYardM,
    widthM, depthM, stories, heightM, roof, roofPitchDeg,
    facadeIndex: rng.int(0, spec.palette.facades.length - 1),
    roofIndex: rng.int(0, spec.palette.roofs.length - 1),
    chimney: rng.bool(b.chimneyRatio),
    solar: rng.bool(b.solarRatio) && roof !== 'flat',
    balcony: stories >= 2 && rng.bool(b.balconyRatio),
    dormer: stories >= 2 && roof !== 'flat' && rng.bool(0.4),
    attached,
    garage,
    garageOffsetM,
    driveLengthM: Math.max(3, spec.block.setbackM - 0.5),
    parkedCar: garage !== 'none' && rng.bool(0.55),
    carColorIndex: rng.int(0, 5),
    boundary,
    bins: rng.bool(0.5) ? rng.int(1, 3) : 0,
    letterbox: rng.bool(0.8),
    bikeRack: rng.bool(0.25),
    trees,
    garden,
    windowSeed: hashInts(plot.seed, 0x57494e),
  }
}
