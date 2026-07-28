/**
 * Single source of truth for the rendering quality tier.
 *
 * Previously the tier lived in a CSS class on <html>, was written by
 * AmbientScene and removed again on its unmount — while ThreeDView read that
 * class back on every render. On routes without AmbientScene (and after every
 * AmbientScene unmount) the class was gone and the reader fell back to "high",
 * i.e. the most expensive path (MSAA 4×, N8AO, DOF, Bloom, chromatic
 * aberration) — on phones too.
 *
 * The tier is now computed once at boot, cached in a module value and only
 * mirrored to the DOM so existing CSS rules keep working. Nothing reads it
 * back from the DOM any more.
 *
 * `prefers-reduced-motion` is deliberately NOT a tier. It suppresses motion,
 * not light: it used to force tier "off", which switched off the room point
 * lights as well and left the evening scene almost black on every device with
 * "Reduce Motion" enabled — a very common iOS setting.
 */

export type Tier = 'high' | 'low' | 'off'

const TIER_CLASSES = ['q-high', 'q-low', 'q-off'] as const

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches
}

let _mobile: boolean | null = null

/**
 * True for phones and tablets. Exported because the render path needs it
 * independently of the tier: post-processing (MSAA render targets, AO, DOF,
 * bloom) is the most fragile and most expensive part of the pipeline on
 * mobile Safari, so the mobile path renders straight to the canvas.
 */
export function isMobileDevice(): boolean {
  if (_mobile !== null) return _mobile
  if (typeof navigator === 'undefined') { _mobile = false; return false }
  const nav = navigator as Navigator & { platform?: string }
  const ua = nav.userAgent || ''
  // iPadOS reports itself as MacIntel with touch points — the classic sniff.
  const isIOS = /iP(hone|ad|od)/.test(ua)
    || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  _mobile = isIOS || /Android/.test(ua)
  return _mobile
}

function detect(): Tier {
  if (typeof navigator === 'undefined') return 'low'
  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency ?? 8
  const mem = nav.deviceMemory ?? 8

  // Phones never get the "high" path. A modern phone reports 8 cores and would
  // previously have been handed MSAA 4x + N8AO + DOF + Bloom.
  if (isMobileDevice()) return (cores >= 6 && mem >= 6) ? 'low' : 'off'

  if (cores <= 4 || mem <= 4) return 'low'
  return 'high'
}

let _tier: Tier | null = null

/** Determine the tier and mirror it onto <html>. Call once, before first render. */
export function initQuality(): Tier {
  if (_tier) return _tier
  _tier = typeof document === 'undefined' ? 'low' : detect()
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.classList.remove(...TIER_CLASSES)
    root.classList.add(`q-${_tier}`)
    if (prefersReducedMotion()) root.classList.add('reduced-motion')
  }
  return _tier
}

/** The tier for this session. Stable — never re-read from the DOM. */
export function getTier(): Tier {
  return _tier ?? initQuality()
}
