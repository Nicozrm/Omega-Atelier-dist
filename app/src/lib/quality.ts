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

export type Tier = 'ultra' | 'high' | 'low' | 'off'

const TIER_CLASSES = ['q-ultra', 'q-high', 'q-low', 'q-off'] as const

/**
 * Rang der Stufen. Ohne ihn wären Abfragen wie „mindestens hoch" auf
 * Gleichheitsvergleiche angewiesen — und genau daran wäre `ultra` gescheitert:
 * im Renderer standen 16 Prüfungen der Form `getTier() === 'high'`. Eine neue,
 * *höhere* Stufe hätte sie alle auf `false` gesetzt und damit ausgerechnet auf
 * dem stärksten Gerät die Qualität **gesenkt**. Deshalb vergleicht ab jetzt
 * niemand mehr auf Gleichheit, sondern über {@link atLeast}.
 */
const RANK: Record<Tier, number> = { off: 0, low: 1, high: 2, ultra: 3 }

/** Ist die aktuelle Stufe mindestens `min`? */
export function atLeast(min: Tier, tier: Tier = getTier()): boolean {
  return RANK[tier] >= RANK[min]
}

/** Kurzform für die überall gebrauchte Frage „darf es etwas kosten?". */
export function isHQ(tier: Tier = getTier()): boolean {
  return atLeast('high', tier)
}

/**
 * Die Maximum-Stufe ist **nie** automatisch. Sie kostet spürbar Bildrate und
 * hängt an der GPU, die der Browser nicht verrät — `hardwareConcurrency` sagt
 * nichts über den Grafikchip. Also entscheidet der Mensch, nicht die Heuristik.
 */
const OVERRIDE_KEY = 'omega.quality.tier'

export function readOverride(): Tier | null {
  try {
    const v = localStorage.getItem(OVERRIDE_KEY)
    return v && v in RANK ? (v as Tier) : null
  } catch {
    return null // Privatmodus o. Ä. — dann eben keine Vorgabe
  }
}

/** Setzt die Stufe dauerhaft. `null` gibt die Automatik zurück. */
export function setOverride(tier: Tier | null): void {
  try {
    if (tier) localStorage.setItem(OVERRIDE_KEY, tier)
    else localStorage.removeItem(OVERRIDE_KEY)
  } catch { /* nicht speicherbar — gilt dann nur für diese Sitzung */ }
  _tier = null
  initQuality()
}

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
  // Die Vorgabe des Nutzers schlägt die Heuristik — in beide Richtungen. Wer
  // „Maximum" wählt, bekommt es auch auf einem Gerät, das die Automatik
  // vorsichtig eingestuft hätte; wer heruntersetzt, wird nicht überstimmt.
  _tier = typeof document === 'undefined' ? 'low' : (readOverride() ?? detect())
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
