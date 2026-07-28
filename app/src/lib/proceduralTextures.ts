/**
 * proceduralTextures.ts — the canvas-drawn material library of the outdoor world.
 *
 * Klinker brick, roof pantiles, board cladding, asphalt, concrete pavers, lawn
 * and the distant night-city wrap are all painted once into an offscreen canvas
 * and cached module-wide, then cloned per surface so each one can carry its own
 * tiling density without a second canvas. That keeps a whole estate's worth of
 * material variety at the cost of a handful of textures.
 *
 * Extracted from the 3D view so the plan's own building and the generated
 * neighbourhood draw from exactly the same surfaces — a house across the street
 * is made of the same brick as the one the user is standing in.
 *
 * Every generator is deterministic (see `texRnd`), so a reload never reshuffles
 * a facade.
 */

import * as THREE from 'three'

export function mkTex(cv: HTMLCanvasElement, srgb: boolean, rep: [number, number] = [1, 1]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(rep[0], rep[1])
  // Max anisotropic filtering — the renderer clamps to the GPU limit. Keeps
  // floors, walls and roofs crisp at grazing angles instead of blurring out.
  t.anisotropy = 16
  return t
}
// Deterministic PRNG so textures are stable across reloads (no reflow flicker).
export function texRnd(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

let _brickTex: { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null
export function brickTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  if (_brickTex) return _brickTex
  const W = 512, H = 512, rows = 13, bh = H / rows, mortar = 3
  const rnd = texRnd(7)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const cx = cv.getContext('2d')!
  const bv = document.createElement('canvas'); bv.width = W; bv.height = H
  const bx = bv.getContext('2d')!
  cx.fillStyle = '#5f5148'; cx.fillRect(0, 0, W, H)          // mortar joint
  bx.fillStyle = '#3a3a3a'; bx.fillRect(0, 0, W, H)          // mortar = recessed
  const bw = W / 4
  for (let r = 0; r < rows; r++) {
    const y = r * bh
    const off = (r % 2) * (bw / 2)                            // running bond
    for (let c = -1; c < 5; c++) {
      const x = c * bw + off
      // Klinker reddish-brown with per-brick variation (some darker sinter bricks)
      const base = rnd()
      const rr = 120 + Math.floor(base * 40), gg = 60 + Math.floor(base * 26), bb = 46 + Math.floor(base * 20)
      cx.fillStyle = `rgb(${rr},${gg},${bb})`
      cx.fillRect(x + mortar / 2, y + mortar / 2, bw - mortar, bh - mortar)
      // subtle top highlight + speckle
      cx.fillStyle = 'rgba(255,236,220,0.05)'
      cx.fillRect(x + mortar / 2, y + mortar / 2, bw - mortar, (bh - mortar) * 0.4)
      for (let s = 0; s < 5; s++) { cx.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.08})`; cx.fillRect(x + mortar + rnd() * (bw - mortar * 2), y + mortar + rnd() * (bh - mortar * 2), 2, 2) }
      bx.fillStyle = `rgb(${205 + Math.floor(base * 40)},${205 + Math.floor(base * 40)},${205 + Math.floor(base * 40)})`
      bx.fillRect(x + mortar / 2, y + mortar / 2, bw - mortar, bh - mortar)
    }
  }
  _brickTex = { map: mkTex(cv, true), bump: mkTex(bv, false) }
  return _brickTex
}

// Vertical timber cladding (Holzverschalung) — warm planks with grain streaks
// and recessed grooves between boards, for the 'board' facade construction.
let _boardTex: { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null
export function boardTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  if (_boardTex) return _boardTex
  const W = 512, H = 512, planks = 6, pw = W / planks
  const rnd = texRnd(23)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const cx = cv.getContext('2d')!
  const bv = document.createElement('canvas'); bv.width = W; bv.height = H
  const bx = bv.getContext('2d')!
  cx.fillStyle = '#6b4a2c'; cx.fillRect(0, 0, W, H)
  bx.fillStyle = '#8a8a8a'; bx.fillRect(0, 0, W, H)
  for (let p = 0; p < planks; p++) {
    const x = p * pw
    const base = 0.82 + rnd() * 0.3
    const rr = Math.floor(120 * base), gg = Math.floor(82 * base), bb = Math.floor(48 * base)
    cx.fillStyle = `rgb(${rr},${gg},${bb})`
    cx.fillRect(x + 1, 0, pw - 2, H)
    // grain streaks
    for (let g = 0; g < 22; g++) {
      cx.strokeStyle = `rgba(${rr - 30},${gg - 22},${bb - 16},${0.18 + rnd() * 0.22})`
      cx.lineWidth = 0.6 + rnd()
      cx.beginPath()
      const gx = x + 2 + rnd() * (pw - 4)
      cx.moveTo(gx, 0); cx.bezierCurveTo(gx + (rnd() - 0.5) * 6, H / 3, gx + (rnd() - 0.5) * 6, (2 * H) / 3, gx + (rnd() - 0.5) * 4, H)
      cx.stroke()
    }
    // plank body slightly raised, grooves recessed (bump)
    bx.fillStyle = `rgb(${185 + Math.floor(base * 30)},${185 + Math.floor(base * 30)},${185 + Math.floor(base * 30)})`
    bx.fillRect(x + 2, 0, pw - 4, H)
    bx.fillStyle = '#2a2a2a'; bx.fillRect(x, 0, 2, H)
  }
  _boardTex = { map: mkTex(cv, true), bump: mkTex(bv, false) }
  return _boardTex
}

let _roofTex: { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null
export function roofTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  if (_roofTex) return _roofTex
  const W = 512, H = 512, rows = 16, rh = H / rows
  const rnd = texRnd(23)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const cx = cv.getContext('2d')!
  const bv = document.createElement('canvas'); bv.width = W; bv.height = H
  const bx = bv.getContext('2d')!
  cx.fillStyle = '#1c1917'; cx.fillRect(0, 0, W, H)
  bx.fillStyle = '#202020'; bx.fillRect(0, 0, W, H)
  const tw = W / 8
  for (let r = 0; r < rows; r++) {
    const y = r * rh
    const off = (r % 2) * (tw / 2)
    for (let c = -1; c < 9; c++) {
      const x = c * tw + off
      const sh = 34 + Math.floor(rnd() * 18)
      cx.fillStyle = `rgb(${sh},${sh - 4},${sh - 6})`
      cx.fillRect(x + 1, y + 1, tw - 2, rh - 1)
      // rounded pantile highlight along the top of each course
      cx.fillStyle = 'rgba(255,255,255,0.06)'
      cx.fillRect(x + 1, y + 1, tw - 2, rh * 0.34)
      cx.fillStyle = 'rgba(0,0,0,0.4)'
      cx.fillRect(x, y + rh - 2, tw, 2)                       // shadow lip between courses
      bx.fillStyle = `rgb(${150 + Math.floor(rnd() * 40)},${150},${150})`
      bx.fillRect(x + 1, y + 1, tw - 2, rh - 2)
    }
  }
  _roofTex = { map: mkTex(cv, true), bump: mkTex(bv, false) }
  return _roofTex
}

let _asphaltTex: THREE.CanvasTexture | null = null
export function asphaltTexture(): THREE.CanvasTexture {
  if (_asphaltTex) return _asphaltTex
  const W = 256, H = 256, rnd = texRnd(41)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const cx = cv.getContext('2d')!
  cx.fillStyle = '#57565a'; cx.fillRect(0, 0, W, H)
  for (let i = 0; i < 9000; i++) {
    const g = rnd()
    cx.fillStyle = g < 0.5 ? `rgba(0,0,0,${0.05 + rnd() * 0.25})` : `rgba(210,210,214,${0.04 + rnd() * 0.14})`
    cx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 1.5, 1 + rnd() * 1.5)
  }
  _asphaltTex = mkTex(cv, true)
  return _asphaltTex
}

let _paverTex: { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null
export function paverTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  if (_paverTex) return _paverTex
  const W = 256, H = 256, n = 4, cell = W / n, rnd = texRnd(59)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const cx = cv.getContext('2d')!
  const bv = document.createElement('canvas'); bv.width = W; bv.height = H
  const bx = bv.getContext('2d')!
  cx.fillStyle = '#6d685f'; cx.fillRect(0, 0, W, H)          // joint sand
  bx.fillStyle = '#404040'; bx.fillRect(0, 0, W, H)
  for (let ry = 0; ry < n; ry++) for (let rx = 0; rx < n; rx++) {
    const off = (ry % 2) * (cell / 2)
    const x = rx * cell + off, y = ry * cell, g = 150 + Math.floor(rnd() * 26)
    cx.fillStyle = `rgb(${g},${g - 4},${g - 12})`
    cx.fillRect(x + 1.5, y + 1.5, cell - 3, cell - 3)
    for (let s = 0; s < 12; s++) { cx.fillStyle = `rgba(0,0,0,${rnd() * 0.06})`; cx.fillRect(x + rnd() * cell, y + rnd() * cell, 2, 2) }
    bx.fillStyle = '#d0d0d0'; bx.fillRect(x + 1.5, y + 1.5, cell - 3, cell - 3)
  }
  _paverTex = { map: mkTex(cv, true), bump: mkTex(bv, false) }
  return _paverTex
}

let _grassTex: THREE.CanvasTexture | null = null
export function grassTexture(): THREE.CanvasTexture {
  if (_grassTex) return _grassTex
  const W = 256, H = 256, rnd = texRnd(83)
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const cx = cv.getContext('2d')!
  cx.fillStyle = '#6a7150'; cx.fillRect(0, 0, W, H)
  // Mowing stripes — faint alternating bands so lawns read manicured.
  const band = W / 8
  for (let b = 0; b < 8; b++) {
    cx.fillStyle = b % 2 === 0 ? 'rgba(255,255,238,0.05)' : 'rgba(10,26,6,0.06)'
    cx.fillRect(b * band, 0, band, H)
  }
  for (let i = 0; i < 14000; i++) {
    const t = rnd()
    const r = 90 + Math.floor(t * 40), g = 108 + Math.floor(t * 46), b = 62 + Math.floor(t * 30)
    cx.fillStyle = `rgba(${r},${g},${b},${0.5})`
    cx.fillRect(rnd() * W, rnd() * H, 1, 1 + rnd() * 3)       // short vertical blades
  }
  _grassTex = mkTex(cv, true)
  return _grassTex
}

let _cityTex: THREE.CanvasTexture | null = null
export function nightCityTexture(): THREE.CanvasTexture {
  if (_cityTex) return _cityTex
  const W = 2048, H = 512
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  // Sky gradient: deep navy at the top → warmer haze at the horizon band.
  const HORIZON = Math.round(H * 0.52)
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON)
  sky.addColorStop(0, '#070b16')
  sky.addColorStop(0.7, '#0e1626')
  sky.addColorStop(1, '#20283c')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, HORIZON)
  // Below the horizon: darker ground haze.
  const grd = ctx.createLinearGradient(0, HORIZON, 0, H)
  grd.addColorStop(0, '#161d2c')
  grd.addColorStop(1, '#05080f')
  ctx.fillStyle = grd
  ctx.fillRect(0, HORIZON, W, H - HORIZON)
  // Warm horizon glow band.
  const glow = ctx.createLinearGradient(0, HORIZON - 60, 0, HORIZON + 30)
  glow.addColorStop(0, 'rgba(255,180,120,0)')
  glow.addColorStop(0.6, 'rgba(255,170,110,0.14)')
  glow.addColorStop(1, 'rgba(255,150,90,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, HORIZON - 60, W, 90)
  // Building silhouettes rising from the horizon, with lit windows.
  let seed = 20260704
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  let x = 0
  while (x < W) {
    const bw = 40 + Math.floor(rnd() * 120)
    const bh = 60 + Math.floor(rnd() * 230)
    const top = HORIZON - bh
    // Silhouette body — near black with a faint cool tint.
    ctx.fillStyle = `rgb(${8 + Math.floor(rnd() * 8)},${12 + Math.floor(rnd() * 8)},${20 + Math.floor(rnd() * 10)})`
    ctx.fillRect(x, top, bw - 3, bh)
    // Window grid — warm and a few cool lit cells, sparse.
    const cols = Math.max(2, Math.floor(bw / 16))
    const rows = Math.max(3, Math.floor(bh / 20))
    for (let cxk = 0; cxk < cols; cxk++) {
      for (let ry = 0; ry < rows; ry++) {
        if (rnd() > 0.34) continue
        const wx = x + 5 + cxk * ((bw - 10) / cols)
        const wy = top + 6 + ry * ((bh - 10) / rows)
        const warm = rnd() > 0.25
        ctx.fillStyle = warm
          ? `rgba(255,${200 + Math.floor(rnd() * 40)},${140 + Math.floor(rnd() * 60)},${0.55 + rnd() * 0.4})`
          : `rgba(${170 + Math.floor(rnd() * 40)},${205 + Math.floor(rnd() * 40)},255,${0.4 + rnd() * 0.35})`
        ctx.fillRect(wx, wy, 3 + rnd() * 3, 4 + rnd() * 3)
      }
    }
    x += bw
  }
  // Scattered stars in the upper sky.
  for (let i = 0; i < 200; i++) {
    const sx = rnd() * W, sy = rnd() * (HORIZON - 80)
    ctx.fillStyle = `rgba(200,215,255,${0.15 + rnd() * 0.35})`
    ctx.fillRect(sx, sy, 1.5, 1.5)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  _cityTex = tex
  return tex
}
