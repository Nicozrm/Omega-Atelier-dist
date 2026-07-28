/**
 * Neighbourhood3D — the renderer for the Living World.
 *
 * Everything drawn here comes from the pure model in `@/lib/world`: the street
 * graph decides where asphalt goes, the plot subdivision decides where houses
 * stand, the amenity pass decides where the supermarket and the park are. This
 * component makes no layout decision of its own — it owns materials and meshes,
 * nothing else. That separation is what lets the same world feed traffic,
 * pedestrians and, later, shading or noise studies.
 *
 * Cost control, in the order it matters:
 *   • **LOD** — buildings carry full trim only near the plan (see `HouseLod`);
 *     further out they lose garnish, then windows, then everything but massing.
 *   • **Batching** — the whole static world is wrapped in `Static`, which merges
 *     by material into a handful of draw calls.
 *   • **Shared textures** — brick, tiles, asphalt and pavers come from the
 *     module-level cache in `@/lib/proceduralTextures`, so a 300-house estate
 *     costs the same texture memory as a single house.
 *
 * Materials and cloned textures are disposed when the world changes.
 */

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { RoundedBox } from '@react-three/drei'
import { Static } from './Static'
import {
  brickTextures, boardTextures, roofTextures, asphaltTexture, paverTextures, grassTexture,
} from '@/lib/proceduralTextures'
import { seasonPalette, snowed, mixHex, type Season } from '@/lib/season'
import type { DayPhase } from '@/lib/environment'
import {
  alongSegment, cityStyleSpec,
  type Amenity, type HouseSpec, type Neighbourhood, type ParkSpec,
  type StreetFurniture, type StreetSegment, type TreeKind, type Vec2,
} from '@/lib/world'

/** Ground sits a hair below the plan's floor slab, as the old estate did. */
const GROUND_Y = -0.13

/**
 * Beyond this distance from the plan a generated building stops casting.
 * The directional light's shadow camera is framed on the plan, so anything
 * further out contributes nothing to the shadow map while still costing a full
 * shadow-pass traversal — with a few hundred houses that is the single largest
 * avoidable per-frame cost in the scene.
 */
const SHADOW_RANGE_M = 28

interface Props {
  world: Neighbourhood
  phase: DayPhase
  /** The environment's continuous exterior-albedo scale (see lib/environment). */
  daylightScale: number
  season: Season
  /** Full trim only where it can be seen. */
  rich: boolean
}

/* ────────────────────────────── Materials ────────────────────────────── */

type MatBag = ReturnType<typeof buildMaterials>

function buildMaterials(world: Neighbourhood, season: Season, daylight: number, phase: DayPhase) {
  const spec = cityStyleSpec(world.style)
  const sp = seasonPalette(season)
  const lit = phase === 'night' || phase === 'dusk' || phase === 'goldenHour'
  const K = daylight

  const ground = (c: string) => snowed(c, sp.snow)
  const roofTint = (c: string) => snowed(c, sp.snow, 0.8)
  const dim = (c: string) => '#' + new THREE.Color(c).multiplyScalar(K).getHexString()

  const S = (c: string, rough = 0.9, metal = 0) =>
    new THREE.MeshStandardMaterial({ color: dim(c), roughness: rough, metalness: metal })
  /** Foliage reads best faceted — flat shading gives crisp low-poly canopies. */
  const F = (c: string) => new THREE.MeshStandardMaterial({ color: dim(c), roughness: 1, flatShading: true })

  const textures: THREE.Texture[] = []
  const clone = (t: THREE.Texture, rx: number, ry: number) => {
    const c = t.clone()
    c.needsUpdate = true
    c.wrapS = c.wrapT = THREE.RepeatWrapping
    c.repeat.set(rx, ry)
    textures.push(c)
    return c
  }

  const brick = brickTextures()
  const board = boardTextures()
  const tiles = roofTextures()
  const pav = paverTextures()

  const pal = spec.palette
  const m = {
    lawn: S(ground(mixHex(pal.lawn, sp.lawn, 0.6)), 1),
    lawnPlot: S(ground(mixHex(pal.lawn, sp.lawn, 0.45)), 1),
    road: S('#ffffff', 0.95),
    kerb: S(pal.kerb, 0.85),
    walk: S('#ffffff', 0.95),
    dash: S('#cfc9bb', 0.9),
    edgeLine: S('#cfc9bb', 0.9),
    zebra: S('#ddd8ca', 0.9),
    drive: S('#ffffff', 0.9),
    gravel: S('#9b968c', 1),
    soil: S('#453728', 1),
    sand: S('#c9b48c', 1),
    water: new THREE.MeshPhysicalMaterial({ color: dim('#2d4a55'), roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.86 }),
    poolWater: new THREE.MeshPhysicalMaterial({ color: dim('#3b7f96'), roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.8 }),

    drain: S('#2c2d31', 0.6, 0.45),
    manhole: S('#3a3b40', 0.6, 0.5),
    metal: S('#7b7f85', 0.45, 0.6),
    dark: S('#26272b', 0.6, 0.2),
    trim: S(pal.trim, 0.9),
    plinth: S('#3d3e42', 0.92),
    frame: S('#2c2d31', 0.6, 0.1),
    sill: S('#d8d3c8', 0.85),
    garageDoor: S('#c6c1b7', 0.7, 0.1),
    door: S('#2a2b30', 0.55, 0.15),
    fence: S(mixHex(pal.trim, '#000000', 0.06), 0.85),
    wall: S(mixHex(pal.facades[1], '#ffffff', 0.1), 0.92),
    ridge: S('#1e1b19', 0.75),
    chimney: S('#4a4b50', 0.9),
    solar: new THREE.MeshStandardMaterial({ color: '#101623', roughness: 0.18, metalness: 0.5 }),
    solarFrame: S('#2e3138', 0.5, 0.4),
    glassRail: new THREE.MeshPhysicalMaterial({ color: dim('#dfe4e6'), roughness: 0.35, transparent: true, opacity: 0.42 }),

    trunk: S('#5b4632', 1),
    hedge: F(sp.hedge),
    hedgeTop: F(mixHex(sp.hedge, '#ffffff', 0.1)),

    // Window glass in three night states — a mix of lit, dim and dark windows
    // is what makes an estate read as inhabited rather than floodlit.
    glassLit: new THREE.MeshStandardMaterial({
      color: lit ? '#ffe3b0' : '#222b37', roughness: 0.16, metalness: lit ? 0 : 0.25,
      emissive: new THREE.Color(lit ? '#ffb457' : '#000000'), emissiveIntensity: lit ? 1.3 : 0,
    }),
    glassDim: new THREE.MeshStandardMaterial({
      color: lit ? '#c8a276' : '#242d3a', roughness: 0.16, metalness: lit ? 0 : 0.25,
      emissive: new THREE.Color(lit ? '#c97f2e' : '#000000'), emissiveIntensity: lit ? 0.45 : 0,
    }),
    glassDark: new THREE.MeshStandardMaterial({ color: dim('#1a212c'), roughness: 0.14, metalness: 0.3 }),
    shopGlass: new THREE.MeshStandardMaterial({
      color: lit ? '#ffeccb' : '#2a3340', roughness: 0.1, metalness: lit ? 0 : 0.3,
      emissive: new THREE.Color(lit ? '#ffcf8a' : '#000000'), emissiveIntensity: lit ? 1.1 : 0,
    }),

    // Street lighting reacts to the sky: the columns switch on at dusk and
    // stay lit through the night, exactly as the estate's real ones do.
    lamp: new THREE.MeshStandardMaterial({
      color: '#1f222a', emissive: new THREE.Color(lit ? '#ffd489' : '#33301f'),
      emissiveIntensity: lit ? 2.8 : 0.15, roughness: 0.5,
    }),
    lampPole: S('#33363c', 0.5, 0.5),
    sconce: new THREE.MeshStandardMaterial({
      color: '#2a2b30', emissive: new THREE.Color(lit ? '#ffd489' : '#2e2a1e'),
      emissiveIntensity: lit ? 2.4 : 0.1, roughness: 0.5,
    }),
    sign: new THREE.MeshStandardMaterial({
      color: '#c8ccd2', emissive: new THREE.Color(lit ? '#8fb4ff' : '#000000'),
      emissiveIntensity: lit ? 0.9 : 0, roughness: 0.5,
    }),
    hydrant: S('#a8342c', 0.7),
    bin: S('#26262b', 0.7),
    binLid: S('#2f4f86', 0.7),
  }

  // ── Textured surfaces ──
  const span = world.extentM * 2
  m.lawn.map = clone(grassTexture(), span / 2.2, span / 2.2)
  m.lawnPlot.map = clone(grassTexture(), 6, 6)
  m.road.map = clone(asphaltTexture(), span / 3, 1.4)
  m.road.color.set(dim(spec.palette.road))
  if (spec.street.surface === 'pavers') {
    m.road.map = clone(pav.map, span / 4, 2)
    m.road.bumpMap = clone(pav.bump, span / 4, 2)
    m.road.bumpScale = 0.008
  }
  m.walk.map = clone(pav.map, span / 2, 0.8)
  m.walk.bumpMap = clone(pav.bump, span / 2, 0.8)
  m.walk.bumpScale = 0.006
  m.walk.color.set(dim(spec.palette.sidewalk))
  m.drive.map = clone(pav.map, 2, 4)
  m.drive.bumpMap = clone(pav.bump, 2, 4)
  m.drive.bumpScale = 0.006
  m.drive.color.set(dim('#e6e2da'))

  // Facades: one material per palette entry, each carrying the surface its
  // style asks for (brick, board, or a smooth render).
  const facades: THREE.MeshStandardMaterial[] = spec.palette.facades.map((hex, i) => {
    const surface = spec.palette.facadeSurface[i] ?? 'plaster'
    const mm = new THREE.MeshStandardMaterial({
      color: dim(hex),
      roughness: surface === 'render' ? 0.82 : 0.88,
      metalness: 0,
    })
    if (surface === 'brick') {
      mm.map = clone(brick.map, 4, 4)
      mm.bumpMap = clone(brick.bump, 4, 4)
      mm.bumpScale = 0.012
      // The brick canvas already carries its own colour, so tint it white-ish
      // and let the palette entry act as a multiplier.
      mm.color.set(dim(mixHex(hex, '#ffffff', 0.35)))
    } else if (surface === 'board') {
      mm.map = clone(board.map, 3, 3)
      mm.bumpMap = clone(board.bump, 3, 3)
      mm.bumpScale = 0.01
      mm.color.set(dim(mixHex(hex, '#ffffff', 0.2)))
    }
    return mm
  })

  const roofs: THREE.MeshStandardMaterial[] = spec.palette.roofs.map((hex) => {
    const mm = new THREE.MeshStandardMaterial({ color: dim(roofTint(hex)), roughness: 0.85, metalness: 0.05 })
    mm.map = clone(tiles.map, 4, 3)
    mm.bumpMap = clone(tiles.bump, 4, 3)
    mm.bumpScale = 0.01
    return mm
  })

  const foliage = sp.foliage.map((c, i) =>
    F(i === 3 && sp.blossom > 0 ? mixHex(c, '#e8b8c8', sp.blossom) : c),
  )

  const carBodies = ['#20242c', '#6b1f22', '#2b3a4d', '#c9c4bc', '#3d5a44', '#8d8f95']
    .map((c) => S(c, 0.35, 0.5))

  const all: THREE.Material[] = [
    ...Object.values(m), ...facades, ...roofs, ...foliage, ...carBodies,
  ]
  return { m, facades, roofs, foliage, carBodies, textures, all, spec, sp }
}

/* ────────────────────────────── Mesh vocabulary ─────────────────────── */

/**
 * A tree. The silhouette is what sells the region — a Mediterranean cypress and
 * a Scandinavian pine must not be the same blob with a different tint — so each
 * canopy kind gets its own construction.
 */
function tree(key: string, kind: TreeKind, at: Vec2, scale: number, mats: MatBag): React.ReactNode {
  const s = scale
  const { m, foliage } = mats
  const lean = (Math.abs(Math.sin(at.x * 12.9898 + at.z * 78.233)) % 1) * 0.08 - 0.04
  const spin = at.x + at.z

  switch (kind) {
    case 'conifer':
      return (
        <group key={key} position={[at.x, GROUND_Y, at.z]} rotation={[0, spin, lean]}>
          <mesh position={[0, 0.5 * s, 0]} castShadow material={m.trunk}><cylinderGeometry args={[0.09 * s, 0.13 * s, 1.0 * s, 6]} /></mesh>
          <mesh position={[0, 1.55 * s, 0]} castShadow material={foliage[1]}><coneGeometry args={[1.0 * s, 1.7 * s, 8]} /></mesh>
          <mesh position={[0, 2.6 * s, 0]} castShadow material={foliage[0]}><coneGeometry args={[0.76 * s, 1.5 * s, 8]} /></mesh>
          <mesh position={[0, 3.45 * s, 0]} castShadow material={foliage[1]}><coneGeometry args={[0.5 * s, 1.15 * s, 8]} /></mesh>
        </group>
      )
    case 'cypress':
      return (
        <group key={key} position={[at.x, GROUND_Y, at.z]} rotation={[0, spin, lean * 0.4]}>
          <mesh position={[0, 0.3 * s, 0]} castShadow material={m.trunk}><cylinderGeometry args={[0.08 * s, 0.11 * s, 0.6 * s, 6]} /></mesh>
          <mesh position={[0, 2.4 * s, 0]} castShadow material={foliage[0]}><coneGeometry args={[0.42 * s, 4.0 * s, 8]} /></mesh>
        </group>
      )
    case 'olive':
      return (
        <group key={key} position={[at.x, GROUND_Y, at.z]} rotation={[0, spin, lean]}>
          <mesh position={[0, 0.62 * s, 0]} castShadow material={m.trunk}><cylinderGeometry args={[0.13 * s, 0.2 * s, 1.25 * s, 7]} /></mesh>
          <mesh position={[0.2 * s, 1.5 * s, 0]} scale={[1.25, 0.66, 1.2]} castShadow material={foliage[3]}><icosahedronGeometry args={[0.9 * s, 1]} /></mesh>
          <mesh position={[-0.45 * s, 1.25 * s, 0.2 * s]} scale={[1.1, 0.6, 1.1]} castShadow material={foliage[2]}><icosahedronGeometry args={[0.62 * s, 1]} /></mesh>
        </group>
      )
    case 'palm': {
      const fronds = [0, 1, 2, 3, 4, 5]
      return (
        <group key={key} position={[at.x, GROUND_Y, at.z]} rotation={[0, spin, lean]}>
          <mesh position={[0, 2.0 * s, 0]} castShadow material={m.trunk}><cylinderGeometry args={[0.13 * s, 0.2 * s, 4.0 * s, 7]} /></mesh>
          {fronds.map((f) => {
            const a = (f / fronds.length) * Math.PI * 2
            return (
              <mesh
                key={f}
                position={[Math.cos(a) * 0.75 * s, 4.05 * s, Math.sin(a) * 0.75 * s]}
                rotation={[0.5, -a, 0]}
                castShadow
                material={foliage[2]}
              >
                <boxGeometry args={[1.7 * s, 0.05 * s, 0.42 * s]} />
              </mesh>
            )
          })}
        </group>
      )
    }
    case 'birch':
      return (
        <group key={key} position={[at.x, GROUND_Y, at.z]} rotation={[0, spin, lean * 1.4]}>
          <mesh position={[0, 1.15 * s, 0]} castShadow material={m.trim}><cylinderGeometry args={[0.07 * s, 0.1 * s, 2.3 * s, 7]} /></mesh>
          <mesh position={[0, 2.7 * s, 0]} scale={[0.86, 1.15, 0.86]} castShadow material={foliage[3]}><icosahedronGeometry args={[0.86 * s, 1]} /></mesh>
          <mesh position={[0.34 * s, 2.2 * s, 0.2 * s]} scale={[0.8, 1, 0.8]} castShadow material={foliage[2]}><icosahedronGeometry args={[0.5 * s, 1]} /></mesh>
        </group>
      )
    default:
      return (
        <group key={key} position={[at.x, GROUND_Y, at.z]} rotation={[0, spin, lean]}>
          <mesh position={[0, 0.85 * s, 0]} castShadow material={m.trunk}><cylinderGeometry args={[0.08 * s, 0.12 * s, 1.7 * s, 7]} /></mesh>
          <mesh position={[0.32 * s, 1.4 * s, 0]} rotation={[0, 0, -0.65]} castShadow material={m.trunk}><cylinderGeometry args={[0.035 * s, 0.055 * s, 0.75 * s, 5]} /></mesh>
          <mesh position={[0, 2.2 * s, 0]} scale={[1, 0.86, 1]} castShadow material={foliage[0]}><icosahedronGeometry args={[1.02 * s, 1]} /></mesh>
          <mesh position={[0.64 * s, 1.9 * s, 0.2 * s]} scale={[1, 0.8, 1]} castShadow material={foliage[1]}><icosahedronGeometry args={[0.6 * s, 1]} /></mesh>
          <mesh position={[-0.52 * s, 1.75 * s, -0.28 * s]} scale={[1, 0.78, 1]} castShadow material={foliage[2]}><icosahedronGeometry args={[0.55 * s, 1]} /></mesh>
          <mesh position={[-0.12 * s, 2.85 * s, 0.3 * s]} castShadow material={foliage[1]}><icosahedronGeometry args={[0.48 * s, 1]} /></mesh>
        </group>
      )
  }
}

/** A window: glass, frame, centre mullion, sill, and a roller-shutter box. */
function windowUnit(
  key: string, x: number, y: number, z: number, w: number, h: number, face: number,
  glass: THREE.Material, mats: MatBag, rich: boolean,
): React.ReactNode {
  const { m } = mats
  return (
    <group key={key} position={[x, y, z]}>
      <mesh position={[0, 0, face * 0.02]} material={glass}><boxGeometry args={[w, h, 0.05]} /></mesh>
      <mesh position={[0, 0, face * 0.03]} material={m.frame}><boxGeometry args={[w + 0.08, h + 0.08, 0.04]} /></mesh>
      {rich && <mesh position={[0, 0, face * 0.05]} material={m.frame}><boxGeometry args={[0.05, h, 0.015]} /></mesh>}
      <mesh position={[0, -h / 2 - 0.04, face * 0.06]} material={m.sill}><boxGeometry args={[w + 0.16, 0.06, 0.12]} /></mesh>
      {rich && <mesh position={[0, h / 2 + 0.11, face * 0.05]} material={m.trim}><boxGeometry args={[w + 0.12, 0.16, 0.1]} /></mesh>}
    </group>
  )
}

/* ────────────────────────────── Buildings ───────────────────────────── */

function houseNode(h: HouseSpec, mats: MatBag, rich: boolean): React.ReactNode {
  const { m, facades, roofs, spec } = mats
  const facade = facades[h.facadeIndex % facades.length]
  const roofMat = roofs[h.roofIndex % roofs.length]
  const { plot } = h
  const parts: React.ReactNode[] = []

  const W = h.widthM
  const D = h.depthM
  const H = h.heightM
  // Local frame: the group is rotated so −z always points at the street.
  const front = -1
  const detail = h.lod === 'full'
  const mid = h.lod !== 'massing'
  // The sun's shadow camera only spans the plan and its immediate surroundings
  // (see the directional light in ThreeDView), so a house further out can never
  // land in the shadow map — it would only cost a second traversal per frame.
  // Casting is therefore limited to the near ring, which is also the only place
  // a neighbour's shadow is visible at all.
  const casts = h.distanceM < SHADOW_RANGE_M

  // Body + plinth
  parts.push(<mesh key="b" position={[0, H / 2, 0]} castShadow={casts} receiveShadow material={facade}><boxGeometry args={[W, H, D]} /></mesh>)
  if (mid) parts.push(<mesh key="pl" position={[0, 0.16, 0]} material={m.plinth}><boxGeometry args={[W + 0.06, 0.32, D + 0.06]} /></mesh>)

  // Roof
  if (h.roof === 'flat') {
    parts.push(<mesh key="rf" position={[0, H + 0.09, 0]} castShadow={casts} material={roofMat}><boxGeometry args={[W + 0.24, 0.18, D + 0.24]} /></mesh>)
    if (detail) parts.push(<mesh key="rfg" position={[0, H + 0.185, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.gravel}><planeGeometry args={[W + 0.06, D + 0.06]} /></mesh>)
  } else if (h.roof === 'pent') {
    const rise = Math.tan((h.roofPitchDeg * Math.PI) / 180) * D
    const ang = Math.atan2(rise, D)
    parts.push(
      <mesh key="rp" position={[0, H + rise / 2, 0]} rotation={[-ang, 0, 0]} castShadow={casts} material={roofMat}>
        <boxGeometry args={[W + 0.3, 0.12, Math.hypot(D, rise) + 0.3]} />
      </mesh>,
    )
  } else if (h.roof === 'hip') {
    const rh = Math.min(W, D) * 0.4
    parts.push(
      <mesh key="rh" position={[0, H + rh / 2, 0]} rotation={[0, Math.PI / 4, 0]} castShadow={casts} material={roofMat}>
        <coneGeometry args={[Math.hypot(W, D) * 0.52, rh, 4]} />
      </mesh>,
    )
  } else {
    // Gable (and mansard, drawn as a steeper gable) — two slopes plus a ridge
    // cap, with the triangular gable ends filled by the facade material.
    const rh = Math.min(W, D) * (h.roof === 'mansard' ? 0.58 : 0.5)
    const slope = Math.hypot(W / 2 + 0.16, rh)
    const ang = Math.atan2(rh, W / 2 + 0.16)
    parts.push(
      <group key="rg" position={[0, H, 0]}>
        <mesh position={[-W / 4, rh / 2, 0]} rotation={[0, 0, ang]} castShadow={casts} material={roofMat}><boxGeometry args={[slope, 0.1, D + 0.5]} /></mesh>
        <mesh position={[W / 4, rh / 2, 0]} rotation={[0, 0, -ang]} castShadow={casts} material={roofMat}><boxGeometry args={[slope, 0.1, D + 0.5]} /></mesh>
        <mesh position={[0, rh + 0.02, 0]} castShadow={casts} material={m.ridge}><boxGeometry args={[0.24, 0.1, D + 0.55]} /></mesh>
        {[-1, 1].map((s) => {
          const sh = new THREE.Shape()
          sh.moveTo(-W / 2, 0); sh.lineTo(W / 2, 0); sh.lineTo(0, rh); sh.closePath()
          return <mesh key={s} position={[0, 0, (s * D) / 2]} material={facade}><shapeGeometry args={[sh]} /></mesh>
        })}
        {/* Zinc gutters along both eaves plus a downpipe to the plinth. */}
        {detail && [-1, 1].map((s) => (
          <group key={`gt${s}`}>
            <mesh position={[s * (W / 2 + 0.22), 0.03, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.metal}><cylinderGeometry args={[0.055, 0.055, D + 0.5, 8]} /></mesh>
            <mesh position={[s * (W / 2 + 0.24), -H / 2 + 0.02, D * 0.32]} material={m.metal}><cylinderGeometry args={[0.04, 0.04, H, 8]} /></mesh>
          </group>
        ))}
        {h.solar && (
          <group position={[-W / 4, rh / 2 + 0.07, front * D * 0.1]} rotation={[0, 0, ang]}>
            <mesh castShadow={casts} material={m.solarFrame}><boxGeometry args={[slope * 0.74, 0.05, D * 0.52]} /></mesh>
            <mesh position={[0, 0.035, 0]} material={m.solar}><boxGeometry args={[slope * 0.7, 0.02, D * 0.48]} /></mesh>
          </group>
        )}
        {h.dormer && detail && (
          <group position={[W / 4, rh * 0.42, front * D * 0.26]}>
            <mesh castShadow={casts} material={m.metal}><boxGeometry args={[W * 0.22, 0.95, 0.55]} /></mesh>
            <mesh position={[0, 0, front * 0.28]} material={m.glassDim}><boxGeometry args={[W * 0.16, 0.62, 0.05]} /></mesh>
          </group>
        )}
      </group>,
    )
  }

  if (h.chimney && mid) {
    parts.push(<mesh key="ch" position={[W * 0.25, H + 0.9, D * 0.1]} castShadow={casts} material={m.chimney}><boxGeometry args={[0.3, 1.1, 0.3]} /></mesh>)
    parts.push(<mesh key="chc" position={[W * 0.25, H + 1.47, D * 0.1]} material={m.dark}><boxGeometry args={[0.4, 0.06, 0.4]} /></mesh>)
  }

  if (mid) {
    // Windows: a pair per storey on the street face, one on the gable flank.
    const pick = (i: number) => {
      const t = ((h.windowSeed >>> (i * 3)) & 7) / 8
      return t < 0.4 ? m.glassLit : t < 0.68 ? m.glassDim : m.glassDark
    }
    for (let s = 0; s < h.stories; s++) {
      const y = 1.25 + s * spec.building.storeyHeightM
      parts.push(windowUnit(`wa${s}`, -W * 0.24, y, front * (D / 2 + 0.03), W * 0.28, 1.15, front, pick(s * 2), mats, detail))
      parts.push(windowUnit(`wb${s}`, W * 0.26, y, front * (D / 2 + 0.03), W * 0.24, 1.15, front, pick(s * 2 + 1), mats, detail))
      if (h.attached !== 'right' && h.attached !== 'both') {
        parts.push(
          <group key={`ws${s}`} position={[W / 2 + 0.03, y, 0]} rotation={[0, Math.PI / 2, 0]}>
            {windowUnit(`wss${s}`, 0, 0, D * 0.02, D * 0.3, 1.1, 1, pick(s + 4), mats, detail)}
          </group>,
        )
      }
      if (detail) parts.push(windowUnit(`wr${s}`, W * 0.12, y, -front * (D / 2 + 0.03), W * 0.34, 1.2, -front, pick(s + 6), mats, detail))
    }

    // Front door with a reveal, a step, a canopy and a warm wall light.
    const dz = front * (D / 2)
    parts.push(<mesh key="drf" position={[0, 1.12, dz + front * 0.02]} material={m.trim}><boxGeometry args={[1.2, 2.3, 0.08]} /></mesh>)
    parts.push(<mesh key="dr" position={[0, 1.05, dz + front * 0.06]} castShadow={casts} material={m.door}><boxGeometry args={[0.95, 2.1, 0.08]} /></mesh>)
    if (detail) {
      parts.push(<mesh key="stp" position={[0, 0.05, dz + front * 0.35]} material={m.walk}><boxGeometry args={[1.3, 0.1, 0.55]} /></mesh>)
      parts.push(<mesh key="cn" position={[0, 2.35, dz + front * 0.35]} castShadow={casts} material={m.dark}><boxGeometry args={[1.6, 0.08, 0.75]} /></mesh>)
      parts.push(<mesh key="sc" position={[0.82, 1.95, dz + front * 0.08]} material={m.sconce}><boxGeometry args={[0.09, 0.22, 0.09]} /></mesh>)
    }
  }

  if (h.balcony && mid) {
    parts.push(
      <group key="bal" position={[0, spec.building.storeyHeightM, -front * (D / 2 + 0.5)]}>
        <mesh castShadow={casts} material={m.trim}><boxGeometry args={[W * 0.55, 0.1, 1.0]} /></mesh>
        <mesh position={[0, 0.45, -front * 0.5]} material={m.glassRail}><boxGeometry args={[W * 0.55, 0.9, 0.04]} /></mesh>
        {[-1, 1].map((s) => (
          <mesh key={s} position={[s * W * 0.275, 0.45, 0]} rotation={[0, Math.PI / 2, 0]} material={m.glassRail}><boxGeometry args={[1.0, 0.9, 0.04]} /></mesh>
        ))}
      </group>,
    )
  }

  // Garage / carport plus its drive out to the kerb.
  if (h.garage !== 'none' && mid) {
    const gx = h.garageOffsetM
    const gz = front * (D * 0.12)
    const gdz = front * (D * 0.12 + D * 0.32 + 0.03)
    if (h.garage === 'garage') {
      parts.push(<mesh key="gb" position={[gx, 1.35, gz]} castShadow={casts} receiveShadow material={facade}><boxGeometry args={[3, 2.7, D * 0.66]} /></mesh>)
      parts.push(<mesh key="gr" position={[gx, 2.75, gz]} castShadow={casts} material={roofMat}><boxGeometry args={[3.2, 0.16, D * 0.66 + 0.2]} /></mesh>)
      parts.push(<mesh key="gd" position={[gx, 1.15, gdz]} material={m.garageDoor}><boxGeometry args={[2.5, 2.1, 0.08]} /></mesh>)
      if (detail) for (const ry of [0.62, 1.15, 1.68]) {
        parts.push(<mesh key={`gl${ry}`} position={[gx, ry, gdz + front * 0.045]} material={m.frame}><boxGeometry args={[2.44, 0.025, 0.02]} /></mesh>)
      }
    } else {
      // Carport: a flat canopy on four slim posts — no walls, no door.
      parts.push(<mesh key="cpr" position={[gx, 2.5, gz]} castShadow={casts} material={m.dark}><boxGeometry args={[3.2, 0.12, D * 0.6]} /></mesh>)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        parts.push(<mesh key={`cp${sx}${sz}`} position={[gx + sx * 1.4, 1.25, gz + sz * D * 0.26]} material={m.metal}><cylinderGeometry args={[0.06, 0.06, 2.5, 6]} /></mesh>)
      }
    }
    parts.push(
      <mesh key="dv" position={[gx, 0.006, front * (D / 2 + h.driveLengthM / 2)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.drive}>
        <planeGeometry args={[2.9, h.driveLengthM]} />
      </mesh>,
    )
    if (h.parkedCar) parts.push(car('pc', { x: gx, z: front * (D / 2 + Math.min(2.6, h.driveLengthM * 0.5)) }, 0, mats.carBodies[h.carColorIndex % mats.carBodies.length], mats, detail))
  }

  // Front garden: lawn strip, path to the door, boundary treatment. Its depth
  // is the setback the generator resolved, so the boundary lands exactly on the
  // property line and never on the pavement.
  const frontLen = h.frontYardM
  parts.push(
    <mesh key="fg" position={[0, 0.003, front * (D / 2 + frontLen / 2)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.lawnPlot}>
      <planeGeometry args={[plot.widthM - 0.6, frontLen]} />
    </mesh>,
  )
  if (mid) {
    parts.push(
      <mesh key="pa" position={[0, 0.006, front * (D / 2 + frontLen / 2)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.walk}>
        <planeGeometry args={[1.2, frontLen]} />
      </mesh>,
    )
  }

  if (mid && h.boundary !== 'open') {
    const by = front * (D / 2 + frontLen * 0.96)
    const segW = (plot.widthM - 1.6) / 2
    for (const sx of [-1, 1]) {
      const x = sx * (segW / 2 + 0.8)
      if (h.boundary === 'hedge') {
        const hh = mats.spec.vegetation.hedgeHeightM
        parts.push(
          <group key={`hg${sx}`} position={[x, 0, by]}>
            <mesh position={[0, hh / 2, 0]} castShadow={casts} material={m.hedge}><boxGeometry args={[segW, hh, 0.44]} /></mesh>
            <mesh position={[sx * segW * 0.08, hh + 0.06, 0]} castShadow={casts} material={m.hedgeTop}><boxGeometry args={[segW * 0.7, 0.14, 0.34]} /></mesh>
          </group>,
        )
      } else if (h.boundary === 'wall') {
        parts.push(
          <group key={`wl${sx}`} position={[x, 0, by]}>
            <mesh position={[0, 0.62, 0]} castShadow={casts} material={m.wall}><boxGeometry args={[segW, 1.24, 0.24]} /></mesh>
            <mesh position={[0, 1.28, 0]} material={m.trim}><boxGeometry args={[segW + 0.08, 0.08, 0.32]} /></mesh>
          </group>,
        )
      } else if (detail) {
        parts.push(
          <group key={`fn${sx}`} position={[x, 0, by]}>
            <mesh position={[0, 0.6, 0]} material={m.fence}><boxGeometry args={[segW, 0.08, 0.05]} /></mesh>
            <mesh position={[0, 0.28, 0]} material={m.fence}><boxGeometry args={[segW, 0.08, 0.05]} /></mesh>
            {[-1, 0, 1].map((p) => (
              <mesh key={p} position={[p * segW * 0.45, 0.36, 0]} castShadow={casts} material={m.fence}><boxGeometry args={[0.08, 0.72, 0.08]} /></mesh>
            ))}
          </group>,
        )
      } else {
        parts.push(<mesh key={`fs${sx}`} position={[x, 0.35, by]} material={m.fence}><boxGeometry args={[segW, 0.7, 0.06]} /></mesh>)
      }
    }
  }

  // Kerbside life: bins, a letterbox, a bike stand.
  if (detail) {
    const kerbZ = front * (D / 2 + frontLen * 0.86)
    if (h.bins > 0) {
      parts.push(
        <group key="bins" position={[plot.widthM * 0.3, 0.4, kerbZ]}>
          {Array.from({ length: h.bins }).map((_, bi) => (
            <group key={bi} position={[bi * 0.52, 0, 0]} rotation={[0, (bi - 0.5) * 0.3, 0]}>
              <mesh castShadow={casts} material={m.bin}><boxGeometry args={[0.42, 0.78, 0.5]} /></mesh>
              <mesh position={[0, 0.42, -0.02]} material={bi % 2 ? m.binLid : m.frame}><boxGeometry args={[0.44, 0.06, 0.54]} /></mesh>
            </group>
          ))}
        </group>,
      )
    }
    if (h.letterbox) {
      parts.push(
        <group key="mb" position={[-plot.widthM * 0.26, 0, kerbZ]}>
          <mesh position={[0, 0.55, 0]} castShadow={casts} material={m.lampPole}><cylinderGeometry args={[0.035, 0.04, 1.1, 8]} /></mesh>
          <RoundedBox position={[0, 1.16, 0]} args={[0.3, 0.22, 0.4]} radius={0.04} smoothness={3} castShadow={casts} material={m.dark} />
          <mesh position={[0, 1.16, 0.205]} material={m.frame}><boxGeometry args={[0.2, 0.03, 0.01]} /></mesh>
        </group>,
      )
    }
    if (h.bikeRack) {
      parts.push(
        <group key="br" position={[plot.widthM * 0.34, 0, front * (D / 2 + 0.9)]}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[i * 0.35 - 0.35, 0.24, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.metal}>
              <torusGeometry args={[0.22, 0.025, 6, 12, Math.PI]} />
            </mesh>
          ))}
        </group>,
      )
    }
  }

  // Garden trees and back-garden features.
  for (const [i, t] of h.trees.entries()) {
    if (!mid && i > 0) break
    parts.push(tree(`t${i}`, t.kind, { x: t.at.x, z: t.at.z }, t.scale, mats))
  }
  if (detail) {
    for (const [i, g] of h.garden.entries()) {
      parts.push(gardenFeature(`g${i}`, g.kind, g.at, g.rotationY, mats))
    }
  }

  return (
    <group key={h.plot.id} position={[h.centre.x, GROUND_Y, h.centre.z]} rotation={[0, plot.rotationY, 0]}>
      {parts}
    </group>
  )
}

function gardenFeature(
  key: string, kind: HouseSpec['garden'][number]['kind'], at: Vec2, rot: number, mats: MatBag,
): React.ReactNode {
  const { m } = mats
  switch (kind) {
    case 'terrace':
      return (
        <group key={key} position={[at.x, 0, at.z]} rotation={[0, rot, 0]}>
          <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.drive}><planeGeometry args={[3.4, 2.3]} /></mesh>
          <mesh position={[0.9, 1.15, 0.2]} material={m.lampPole}><cylinderGeometry args={[0.03, 0.03, 2.3, 6]} /></mesh>
          <mesh position={[0.9, 2.35, 0.2]} castShadow material={m.trim}><coneGeometry args={[1.1, 0.52, 8]} /></mesh>
          <mesh position={[-0.5, 0.36, -0.2]} material={m.frame}><cylinderGeometry args={[0.045, 0.045, 0.72, 6]} /></mesh>
          <mesh position={[-0.5, 0.75, -0.2]} castShadow material={m.trim}><cylinderGeometry args={[0.46, 0.46, 0.05, 12]} /></mesh>
        </group>
      )
    case 'trampoline':
      return (
        <group key={key} position={[at.x, 0, at.z]}>
          <mesh position={[0, 0.64, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow material={m.dark}><torusGeometry args={[1.0, 0.07, 8, 20]} /></mesh>
          <mesh position={[0, 0.62, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.frame}><circleGeometry args={[0.95, 20]} /></mesh>
          {[0, 1, 2, 3].map((k) => {
            const a = (k / 4) * Math.PI * 2 + 0.5
            return <mesh key={k} position={[Math.cos(a) * 0.86, 0.32, Math.sin(a) * 0.86]} material={m.dark}><cylinderGeometry args={[0.035, 0.035, 0.62, 6]} /></mesh>
          })}
        </group>
      )
    case 'pool':
      return (
        <group key={key} position={[at.x, 0, at.z]} rotation={[0, rot, 0]}>
          <mesh position={[0, 0.02, 0]} material={m.trim}><boxGeometry args={[5.2, 0.12, 3.2]} /></mesh>
          <mesh position={[0, 0.09, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.poolWater}><planeGeometry args={[4.6, 2.6]} /></mesh>
        </group>
      )
    case 'shed':
      return (
        <group key={key} position={[at.x, 0, at.z]} rotation={[0, rot, 0]}>
          <mesh position={[0, 1.0, 0]} castShadow material={m.fence}><boxGeometry args={[2.2, 2.0, 1.8]} /></mesh>
          <mesh position={[0, 2.08, 0]} rotation={[0.18, 0, 0]} castShadow material={m.dark}><boxGeometry args={[2.5, 0.1, 2.1]} /></mesh>
        </group>
      )
    case 'washing':
      return (
        <group key={key} position={[at.x, 0, at.z]} rotation={[0, rot, 0]}>
          <mesh position={[0, 0.95, 0]} material={m.metal}><cylinderGeometry args={[0.04, 0.05, 1.9, 6]} /></mesh>
          {[0, 1, 2, 3].map((k) => {
            const a = (k / 4) * Math.PI * 2
            return (
              <group key={k}>
                <mesh position={[Math.cos(a) * 0.7, 1.75, Math.sin(a) * 0.7]} rotation={[0, -a, 0.24]} material={m.metal}><boxGeometry args={[1.5, 0.02, 0.02]} /></mesh>
                <mesh position={[Math.cos(a) * 0.8, 1.5, Math.sin(a) * 0.8]} rotation={[0, -a, 0]} material={m.trim}><boxGeometry args={[0.45, 0.5, 0.01]} /></mesh>
              </group>
            )
          })}
        </group>
      )
    case 'vegetable':
      return (
        <group key={key} position={[at.x, 0, at.z]}>
          {[0, 1].map((r) => (
            <group key={r} position={[0, 0, r * 0.9 - 0.45]}>
              <mesh position={[0, 0.09, 0]} material={m.soil}><boxGeometry args={[2.4, 0.18, 0.7]} /></mesh>
              {[0, 1, 2, 3].map((c) => (
                <mesh key={c} position={[c * 0.6 - 0.9, 0.28, 0]} material={m.hedgeTop}><icosahedronGeometry args={[0.16, 0]} /></mesh>
              ))}
            </group>
          ))}
        </group>
      )
    default:
      return null
  }
}

/** A car body — shared by driveways, parking bays and moving traffic. */
export function car(
  key: string, at: Vec2, rot: number, body: THREE.Material, mats: MatBag, detail = true,
): React.ReactNode {
  const { m } = mats
  return (
    <group key={key} position={[at.x, 0, at.z]} rotation={[0, rot, 0]}>
      <RoundedBox position={[0, 0.46, 0]} args={[1.84, 0.52, 4.3]} radius={0.14} smoothness={3} castShadow material={body} />
      <RoundedBox position={[0, 0.88, -0.2]} args={[1.66, 0.5, 2.25]} radius={0.12} smoothness={3} castShadow material={body} />
      <RoundedBox position={[0, 0.88, -0.2]} args={[1.68, 0.4, 2.05]} radius={0.1} smoothness={3} material={m.glassDark} />
      {detail && [-1, 1].map((s) => (
        <mesh key={`h${s}`} position={[s * 0.6, 0.54, 2.12]} material={m.sign}><boxGeometry args={[0.36, 0.1, 0.06]} /></mesh>
      ))}
      {detail && <mesh position={[0, 0.56, -2.12]} material={m.hydrant}><boxGeometry args={[1.46, 0.08, 0.06]} /></mesh>}
      {([[-0.88, 1.32], [0.88, 1.32], [-0.88, -1.32], [0.88, -1.32]] as const).map(([wx, wz], i) => (
        <group key={i} position={[wx, 0.33, wz]} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow material={m.dark}><cylinderGeometry args={[0.33, 0.33, 0.22, 12]} /></mesh>
          {detail && <mesh position={[0, -Math.sign(wx) * 0.12, 0]} material={m.metal}><cylinderGeometry args={[0.19, 0.19, 0.04, 10]} /></mesh>}
        </group>
      ))}
    </group>
  )
}

/* ────────────────────────────── Streets ─────────────────────────────── */

function streetNodes(world: Neighbourhood, mats: MatBag, rich: boolean): React.ReactNode[] {
  const { m, spec } = mats
  const out: React.ReactNode[] = []

  for (const seg of world.network.segments) {
    const mid = { x: (seg.a.x + seg.b.x) / 2, z: (seg.a.z + seg.b.z) / 2 }
    const rotY = seg.horizontal ? 0 : Math.PI / 2
    const L = seg.lengthM
    const W = seg.widthM

    out.push(
      <group key={`st-${seg.id}`} position={[mid.x, GROUND_Y, mid.z]} rotation={[0, rotY, 0]}>
        <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.road}><planeGeometry args={[L, W]} /></mesh>
        {seg.sidewalkM > 0 && [-1, 1].map((s) => (
          <group key={s}>
            <mesh position={[0, 0.03, s * (W / 2 + 0.09)]} material={m.kerb}><boxGeometry args={[L, 0.12, 0.18]} /></mesh>
            <mesh position={[0, 0.006, s * (W / 2 + 0.18 + seg.sidewalkM / 2)]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.walk}>
              <planeGeometry args={[L, seg.sidewalkM]} />
            </mesh>
          </group>
        ))}
        {/* Painted markings — the biggest "real road" cue, and per-region. */}
        {spec.street.edgeLines && [-1, 1].map((s) => (
          <mesh key={`e${s}`} position={[0, 0.007, s * (W / 2 - 0.16)]} rotation={[-Math.PI / 2, 0, 0]} material={m.edgeLine}><planeGeometry args={[L, 0.1]} /></mesh>
        ))}
        {(spec.street.centreLine || seg.kind === 'collector') && (
          Array.from({ length: Math.max(1, Math.floor(L / 6)) }).map((_, i, arr) => (
            <mesh key={`d${i}`} position={[(i / arr.length - 0.5) * L + L / (arr.length * 2), 0.007, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.dash}>
              <planeGeometry args={[2.2, 0.14]} />
            </mesh>
          ))
        )}
        {/* Roadside parking bays on the quiet streets — the estate reads used. */}
        {rich && seg.kind === 'residential' && (
          <mesh position={[0, 0.0065, W / 2 - 1.05]} rotation={[-Math.PI / 2, 0, 0]} material={m.edgeLine}><planeGeometry args={[L * 0.5, 0.08]} /></mesh>
        )}
      </group>,
    )
  }

  // Junction character: the roundabout is a real island with a kerb ring.
  for (const node of world.network.nodes.values()) {
    if (node.roundabout) {
      out.push(
        <group key={`ra-${node.id}`} position={[node.at.x, GROUND_Y, node.at.z]}>
          <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.road}><circleGeometry args={[11, 32]} /></mesh>
          <mesh position={[0, 0.05, 0]} material={m.kerb}><cylinderGeometry args={[4.4, 4.4, 0.2, 28]} /></mesh>
          <mesh position={[0, 0.16, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.lawnPlot}><circleGeometry args={[4.2, 28]} /></mesh>
          {tree('ra-tree', 'broadleaf', { x: 0, z: 0 }, 1.3, mats)}
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i / 8) * Math.PI * 2
            return <mesh key={i} position={[Math.cos(a) * 5.4, 0.28, Math.sin(a) * 5.4]} material={m.sign}><cylinderGeometry args={[0.07, 0.07, 0.56, 6]} /></mesh>
          })}
        </group>,
      )
    }
    if (node.crossing) {
      out.push(
        <group key={`cr-${node.id}`} position={[node.at.x, GROUND_Y, node.at.z]}>
          {Array.from({ length: 7 }).map((_, b) => (
            <mesh key={b} position={[(b - 3) * 0.62, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.zebra}><planeGeometry args={[0.42, 7]} /></mesh>
          ))}
        </group>,
      )
    }
  }

  return out
}

function furnitureNode(f: StreetFurniture, i: number, mats: MatBag): React.ReactNode {
  const { m } = mats
  const p: [number, number, number] = [f.at.x, GROUND_Y, f.at.z]
  switch (f.kind) {
    case 'lamp':
      return (
        <group key={`f${i}`} position={p} rotation={[0, f.rotationY, 0]}>
          <mesh position={[0, 0.05, 0]} material={m.lampPole}><cylinderGeometry args={[0.11, 0.14, 0.1, 8]} /></mesh>
          <mesh position={[0, 1.9, 0]} castShadow material={m.lampPole}><cylinderGeometry args={[0.045, 0.06, 3.7, 8]} /></mesh>
          <mesh position={[0, 3.68, 0]} material={m.lamp}><cylinderGeometry args={[0.07, 0.075, 0.14, 8]} /></mesh>
          <mesh position={[0, 3.82, 0]} material={m.lampPole}><cylinderGeometry args={[0.1, 0.055, 0.16, 8]} /></mesh>
        </group>
      )
    case 'busStop':
      return (
        <group key={`f${i}`} position={p} rotation={[0, f.rotationY, 0]}>
          <mesh position={[0, 1.3, -0.6]} material={m.glassRail}><boxGeometry args={[3.4, 2.2, 0.06]} /></mesh>
          <mesh position={[0, 2.45, 0]} castShadow material={m.metal}><boxGeometry args={[3.6, 0.1, 1.5]} /></mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 1.7, 1.22, 0]} material={m.metal}><cylinderGeometry args={[0.05, 0.05, 2.45, 6]} /></mesh>
          ))}
          <mesh position={[0, 0.55, 0.35]} material={m.fence}><boxGeometry args={[2.4, 0.08, 0.4]} /></mesh>
          <mesh position={[1.95, 2.2, 0]} material={m.sign}><boxGeometry args={[0.05, 0.5, 0.7]} /></mesh>
        </group>
      )
    case 'hydrant':
      return (
        <group key={`f${i}`} position={p}>
          <mesh position={[0, 0.35, 0]} castShadow material={m.hydrant}><cylinderGeometry args={[0.12, 0.15, 0.7, 8]} /></mesh>
          <mesh position={[0, 0.74, 0]} material={m.hydrant}><sphereGeometry args={[0.13, 8, 6]} /></mesh>
        </group>
      )
    case 'litterBin':
      return (
        <group key={`f${i}`} position={p}>
          <mesh position={[0, 0.55, 0]} castShadow material={m.dark}><cylinderGeometry args={[0.22, 0.19, 0.7, 10]} /></mesh>
          <mesh position={[0, 0.28, 0]} material={m.lampPole}><cylinderGeometry args={[0.04, 0.04, 0.55, 6]} /></mesh>
        </group>
      )
    case 'bench':
      return (
        <group key={`f${i}`} position={p} rotation={[0, f.rotationY, 0]}>
          <mesh position={[0, 0.45, 0]} castShadow material={m.trunk}><boxGeometry args={[1.7, 0.08, 0.5]} /></mesh>
          <mesh position={[0, 0.72, -0.22]} rotation={[-0.25, 0, 0]} material={m.trunk}><boxGeometry args={[1.7, 0.08, 0.36]} /></mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.72, 0.22, 0]} material={m.dark}><boxGeometry args={[0.08, 0.44, 0.46]} /></mesh>
          ))}
        </group>
      )
    case 'signpost':
      return (
        <group key={`f${i}`} position={p} rotation={[0, f.rotationY, 0]}>
          <mesh position={[0, 1.1, 0]} material={m.metal}><cylinderGeometry args={[0.035, 0.035, 2.2, 6]} /></mesh>
          <mesh position={[0, 2.05, 0]} material={m.sign}><boxGeometry args={[0.02, 0.32, 0.32]} /></mesh>
        </group>
      )
    case 'bollard':
      return <mesh key={`f${i}`} position={[p[0], p[1] + 0.42, p[2]]} material={m.metal}><cylinderGeometry args={[0.06, 0.07, 0.84, 8]} /></mesh>
    case 'cabinet':
      return (
        <group key={`f${i}`} position={p} rotation={[0, f.rotationY, 0]}>
          <mesh position={[0, 0.68, 0]} castShadow material={m.lampPole}><boxGeometry args={[0.9, 1.36, 0.38]} /></mesh>
          <mesh position={[0, 1.38, 0]} material={m.dark}><boxGeometry args={[0.96, 0.06, 0.44]} /></mesh>
        </group>
      )
    case 'manhole':
      return <mesh key={`f${i}`} position={[p[0], p[1] + 0.007, p[2]]} rotation={[-Math.PI / 2, 0, 0]} material={m.manhole}><circleGeometry args={[0.32, 16]} /></mesh>
    case 'drain':
      return <mesh key={`f${i}`} position={[p[0], p[1] + 0.007, p[2]]} rotation={[-Math.PI / 2, 0, 0]} material={m.drain}><planeGeometry args={[0.5, 0.24]} /></mesh>
    default:
      return null
  }
}

/* ────────────────────────────── Amenities ───────────────────────────── */

function amenityNode(a: Amenity, mats: MatBag, rich: boolean): React.ReactNode {
  const { m, facades } = mats
  const parts: React.ReactNode[] = []
  const W = a.widthM
  const D = a.depthM
  const H = a.heightM
  const shell = facades[2 % facades.length]

  if (a.kind === 'supermarket') {
    parts.push(<mesh key="b" position={[0, H / 2, 0]} castShadow receiveShadow material={shell}><boxGeometry args={[W, H, D]} /></mesh>)
    parts.push(<mesh key="r" position={[0, H + 0.12, 0]} castShadow material={m.metal}><boxGeometry args={[W + 0.6, 0.24, D + 0.6]} /></mesh>)
    // Full-height glazing across the entrance front, with a projecting canopy.
    parts.push(<mesh key="g" position={[0, 2.1, D / 2 + 0.04]} material={m.shopGlass}><boxGeometry args={[W * 0.72, 4.0, 0.08]} /></mesh>)
    parts.push(<mesh key="c" position={[0, 4.4, D / 2 + 1.6]} castShadow material={m.metal}><boxGeometry args={[W * 0.86, 0.16, 3.2]} /></mesh>)
    parts.push(<mesh key="s" position={[0, 5.4, D / 2 + 0.1]} material={m.sign}><boxGeometry args={[W * 0.42, 0.9, 0.14]} /></mesh>)
    // Rooftop plant — every store has it and it breaks the flat silhouette.
    if (rich) for (const [i, ox] of [-0.24, 0.06, 0.3].entries()) {
      parts.push(<mesh key={`u${i}`} position={[W * ox, H + 0.6, -D * 0.2]} castShadow material={m.metal}><boxGeometry args={[2.4, 0.9, 1.8]} /></mesh>)
    }

    if (a.parking) {
      const lot = a.parking
      const lotW = lot.baysPerRow * lot.bayWidthM
      const lotD = lot.rows * lot.bayDepthM + lot.aisleM
      const offZ = lot.at.z - a.at.z
      parts.push(
        <group key="lot" position={[lot.at.x - a.at.x, 0, offZ]}>
          <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.road}><planeGeometry args={[lotW + 4, lotD + 3]} /></mesh>
          {/* Bay markings — one line per bay boundary, both rows. */}
          {Array.from({ length: lot.rows }).map((_, r) => (
            <group key={r} position={[0, 0, (r - 0.5) * (lot.bayDepthM + lot.aisleM / 2)]}>
              {Array.from({ length: lot.baysPerRow + 1 }).map((_, b) => (
                <mesh key={b} position={[(b - lot.baysPerRow / 2) * lot.bayWidthM, 0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.edgeLine}>
                  <planeGeometry args={[0.1, lot.bayDepthM]} />
                </mesh>
              ))}
            </group>
          ))}
          {/* Parked cars — the lot is never empty and never full. */}
          {rich && lot.occupied.slice(0, 26).map((idx) => {
            const r = Math.floor(idx / lot.baysPerRow)
            const b = idx % lot.baysPerRow
            return car(
              `lc${idx}`,
              { x: (b - lot.baysPerRow / 2 + 0.5) * lot.bayWidthM, z: (r - 0.5) * (lot.bayDepthM + lot.aisleM / 2) },
              0,
              mats.carBodies[idx % mats.carBodies.length],
              mats,
              false,
            )
          })}
          {/* Trolley shelters — a roof on posts with a rank of trolleys. */}
          {lot.trolleyShelters.map((t, i) => (
            <group key={`ts${i}`} position={[t.x, 0, t.z]}>
              <mesh position={[0, 2.3, 0]} castShadow material={m.metal}><boxGeometry args={[3.0, 0.08, 1.9]} /></mesh>
              {[-1, 1].map((s) => (
                <mesh key={s} position={[s * 1.4, 1.15, 0]} material={m.metal}><cylinderGeometry args={[0.05, 0.05, 2.3, 6]} /></mesh>
              ))}
              {rich && Array.from({ length: 5 }).map((_, k) => (
                <mesh key={k} position={[k * 0.28 - 0.6, 0.5, 0]} material={m.metal}><boxGeometry args={[0.5, 0.9, 0.55]} /></mesh>
              ))}
            </group>
          ))}
          {/* EV charging — a post with a lit status band per bay. */}
          {lot.chargers.map((c, i) => (
            <group key={`ch${i}`} position={[c.x, 0, c.z]}>
              <mesh position={[0, 0.75, 0]} castShadow material={m.lampPole}><boxGeometry args={[0.34, 1.5, 0.24]} /></mesh>
              <mesh position={[0, 1.2, 0.13]} material={m.lamp}><boxGeometry args={[0.22, 0.1, 0.03]} /></mesh>
            </group>
          ))}
        </group>,
      )
    }
  } else if (a.kind === 'fuel') {
    parts.push(<mesh key="k" position={[0, 1.6, -D / 2 + 2]} castShadow material={shell}><boxGeometry args={[W * 0.4, 3.2, 4]} /></mesh>)
    parts.push(<mesh key="c" position={[0, 5.0, 1]} castShadow material={m.trim}><boxGeometry args={[W, 0.5, D * 0.7]} /></mesh>)
    for (const [i, sx] of [-1, 1].entries()) {
      parts.push(<mesh key={`p${i}`} position={[sx * W * 0.3, 2.5, 1]} material={m.metal}><cylinderGeometry args={[0.14, 0.14, 5, 8]} /></mesh>)
      parts.push(<mesh key={`d${i}`} position={[sx * 2.2, 0.7, 1]} castShadow material={m.sign}><boxGeometry args={[0.7, 1.4, 1.2]} /></mesh>)
    }
  } else {
    // Parade unit: shop front, sign band, awning.
    parts.push(<mesh key="b" position={[0, H / 2, 0]} castShadow receiveShadow material={shell}><boxGeometry args={[W, H, D]} /></mesh>)
    parts.push(<mesh key="r" position={[0, H + 0.08, 0]} castShadow material={m.metal}><boxGeometry args={[W + 0.3, 0.16, D + 0.3]} /></mesh>)
    parts.push(<mesh key="g" position={[0, 1.5, D / 2 + 0.04]} material={m.shopGlass}><boxGeometry args={[W * 0.8, 2.6, 0.08]} /></mesh>)
    parts.push(<mesh key="s" position={[0, 3.4, D / 2 + 0.08]} material={m.sign}><boxGeometry args={[W * 0.78, 0.55, 0.1]} /></mesh>)
    if (rich) {
      parts.push(<mesh key="aw" position={[0, 3.0, D / 2 + 0.7]} rotation={[0.32, 0, 0]} castShadow material={m.hydrant}><boxGeometry args={[W * 0.82, 0.06, 1.5]} /></mesh>)
      // Pavement tables outside the café.
      if (a.kind === 'cafe') {
        for (const [i, ox] of [-1.6, 0.2, 2.0].entries()) {
          parts.push(
            <group key={`tb${i}`} position={[ox, 0, D / 2 + 2.2]}>
              <mesh position={[0, 0.36, 0]} material={m.frame}><cylinderGeometry args={[0.04, 0.04, 0.72, 6]} /></mesh>
              <mesh position={[0, 0.74, 0]} castShadow material={m.trim}><cylinderGeometry args={[0.36, 0.36, 0.05, 12]} /></mesh>
              {[-1, 1].map((s) => (
                <mesh key={s} position={[s * 0.6, 0.42, 0]} castShadow material={m.dark}><boxGeometry args={[0.4, 0.06, 0.4]} /></mesh>
              ))}
            </group>,
          )
        }
      }
    }
  }

  return <group key={a.id} position={[a.at.x, GROUND_Y, a.at.z]} rotation={[0, a.rotationY, 0]}>{parts}</group>
}

function parkNode(park: ParkSpec, mats: MatBag, rich: boolean): React.ReactNode {
  const { m } = mats
  const w = park.maxX - park.minX
  const d = park.maxZ - park.minZ
  const cx = (park.minX + park.maxX) / 2
  const cz = (park.minZ + park.maxZ) / 2
  const parts: React.ReactNode[] = []

  parts.push(<mesh key="g" position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.lawnPlot}><planeGeometry args={[w, d]} /></mesh>)

  // Gravel path: one quad per polyline leg.
  for (let i = 1; i < park.path.length; i++) {
    const a = park.path[i - 1]
    const b = park.path[i]
    const mx = (a.x + b.x) / 2 - cx
    const mz = (a.z + b.z) / 2 - cz
    const L = Math.hypot(b.x - a.x, b.z - a.z)
    const ang = Math.atan2(b.z - a.z, b.x - a.x)
    parts.push(
      <mesh key={`p${i}`} position={[mx, 0.008, mz]} rotation={[-Math.PI / 2, 0, -ang]} receiveShadow material={m.gravel}>
        <planeGeometry args={[L + 1.2, 1.8]} />
      </mesh>,
    )
  }

  if (park.pond) {
    parts.push(
      <group key="pond" position={[park.pond.at.x - cx, 0, park.pond.at.z - cz]}>
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.soil}><circleGeometry args={[park.pond.radiusM + 0.6, 24]} /></mesh>
        <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} material={m.water}><circleGeometry args={[park.pond.radiusM, 24]} /></mesh>
      </group>,
    )
  }

  if (park.playground) {
    const pg = park.playground
    const items: React.ReactNode[] = []
    for (const [i, it] of pg.items.entries()) {
      const at: [number, number, number] = [it.at.x, 0, it.at.z]
      if (it.kind === 'swing') {
        items.push(
          <group key={i} position={at} rotation={[0, it.rotationY, 0]}>
            {[-1, 1].map((s) => (
              <group key={s}>
                <mesh position={[s * 1.1, 1.0, -0.5]} rotation={[0, 0, s * 0.2]} material={m.metal}><cylinderGeometry args={[0.05, 0.05, 2.1, 6]} /></mesh>
                <mesh position={[s * 1.1, 1.0, 0.5]} rotation={[0, 0, s * 0.2]} material={m.metal}><cylinderGeometry args={[0.05, 0.05, 2.1, 6]} /></mesh>
              </group>
            ))}
            <mesh position={[0, 2.0, 0]} rotation={[0, 0, Math.PI / 2]} material={m.metal}><cylinderGeometry args={[0.05, 0.05, 2.4, 6]} /></mesh>
            {[-0.6, 0.6].map((ox) => (
              <group key={ox}>
                <mesh position={[ox, 1.3, 0]} material={m.dark}><cylinderGeometry args={[0.012, 0.012, 1.4, 4]} /></mesh>
                <mesh position={[ox, 0.6, 0]} material={m.hydrant}><boxGeometry args={[0.42, 0.05, 0.2]} /></mesh>
              </group>
            ))}
          </group>,
        )
      } else if (it.kind === 'slide') {
        items.push(
          <group key={i} position={at} rotation={[0, it.rotationY, 0]}>
            <mesh position={[0, 0.8, -0.6]} castShadow material={m.trunk}><boxGeometry args={[1.1, 1.6, 1.1]} /></mesh>
            <mesh position={[0, 0.85, 0.9]} rotation={[0.62, 0, 0]} castShadow material={m.metal}><boxGeometry args={[0.7, 0.06, 2.4]} /></mesh>
          </group>,
        )
      } else if (it.kind === 'sandpit') {
        items.push(
          <group key={i} position={at}>
            <mesh position={[0, 0.06, 0]} material={m.sand}><boxGeometry args={[3.0, 0.12, 3.0]} /></mesh>
            <mesh position={[0, 0.16, 0]} material={m.trunk}><boxGeometry args={[3.2, 0.16, 0.18]} /></mesh>
          </group>,
        )
      } else if (it.kind === 'climb') {
        items.push(
          <group key={i} position={at} rotation={[0, it.rotationY, 0]}>
            {[-1, 1].map((s) => [-1, 1].map((t) => (
              <mesh key={`${s}${t}`} position={[s * 0.7, 0.85, t * 0.7]} material={m.metal}><cylinderGeometry args={[0.045, 0.045, 1.7, 6]} /></mesh>
            )))}
            {[0.6, 1.1, 1.6].map((y) => (
              <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={m.metal}><torusGeometry args={[0.7, 0.03, 4, 4]} /></mesh>
            ))}
          </group>,
        )
      } else if (it.kind === 'seesaw') {
        items.push(
          <group key={i} position={at} rotation={[0, it.rotationY, 0]}>
            <mesh position={[0, 0.35, 0]} material={m.metal}><boxGeometry args={[0.2, 0.7, 0.2]} /></mesh>
            <mesh position={[0, 0.72, 0]} rotation={[0, 0, 0.14]} castShadow material={m.hydrant}><boxGeometry args={[2.6, 0.08, 0.28]} /></mesh>
          </group>,
        )
      } else {
        items.push(
          <group key={i} position={at} rotation={[0, it.rotationY, 0]}>
            <mesh position={[0, 0.45, 0]} castShadow material={m.trunk}><boxGeometry args={[1.7, 0.08, 0.5]} /></mesh>
            {[-1, 1].map((s) => (
              <mesh key={s} position={[s * 0.72, 0.22, 0]} material={m.dark}><boxGeometry args={[0.08, 0.44, 0.46]} /></mesh>
            ))}
          </group>,
        )
      }
    }
    parts.push(
      <group key="pg" position={[pg.at.x - cx, 0, pg.at.z - cz]}>
        <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={m.sand}><circleGeometry args={[pg.radiusM, 24]} /></mesh>
        {items}
      </group>,
    )
  }

  for (const [i, t] of park.trees.entries()) {
    if (!rich && i % 2 === 1) continue
    parts.push(tree(`pt${i}`, i % 3 === 0 ? 'conifer' : 'broadleaf', { x: t.at.x - cx, z: t.at.z - cz }, t.scale, mats))
  }
  if (rich) {
    for (const [i, b] of park.benches.entries()) {
      parts.push(
        <group key={`bn${i}`} position={[b.at.x - cx, 0, b.at.z - cz]} rotation={[0, b.rotationY, 0]}>
          <mesh position={[0, 0.45, 0]} castShadow material={m.trunk}><boxGeometry args={[1.7, 0.08, 0.5]} /></mesh>
          <mesh position={[0, 0.72, -0.22]} rotation={[-0.25, 0, 0]} material={m.trunk}><boxGeometry args={[1.7, 0.08, 0.36]} /></mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.72, 0.22, 0]} material={m.dark}><boxGeometry args={[0.08, 0.44, 0.46]} /></mesh>
          ))}
        </group>,
      )
    }
  }

  return <group key="park" position={[cx, GROUND_Y, cz]}>{parts}</group>
}

/* ────────────────────────────── Component ───────────────────────────── */

export function Neighbourhood3D({ world, phase, daylightScale, season, rich }: Props) {
  const built = useMemo(() => {
    const mats = buildMaterials(world, season, daylightScale, phase)
    const nodes: React.ReactNode[] = []

    // Ground plane under everything — blocks, verges and the space beyond.
    const size = world.extentM * 2.4
    nodes.push(
      <mesh key="ground" position={[world.network.centre.x, GROUND_Y - 0.002, world.network.centre.z]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow material={mats.m.lawn}>
        <planeGeometry args={[size, size]} />
      </mesh>,
    )

    nodes.push(...streetNodes(world, mats, rich))
    for (const h of world.houses) nodes.push(houseNode(h, mats, rich))
    for (const a of world.amenities) nodes.push(amenityNode(a, mats, rich))
    if (world.park) nodes.push(parkNode(world.park, mats, rich))
    for (const [i, f] of world.furniture.entries()) {
      // Drains and manholes are pure garnish at low tier.
      if (!rich && (f.kind === 'drain' || f.kind === 'manhole' || f.kind === 'signpost')) continue
      nodes.push(furnitureNode(f, i, mats))
    }

    return { nodes, mats }
  }, [world, phase, daylightScale, season, rich])

  useEffect(() => {
    const { all, textures } = built.mats
    return () => {
      all.forEach((mm) => mm.dispose())
      textures.forEach((t) => t.dispose())
    }
  }, [built])

  return <Static>{built.nodes}</Static>
}

export { GROUND_Y, buildMaterials }
export type { MatBag }
