/**
 * deadline.ts — jede externe Anfrage bekommt eine Frist.
 *
 * Anlass war ein Fehler, der genau die Eigenschaft zerstört hat, die die
 * Quellen-Schicht ausmachen sollte: `signal ?? AbortSignal.timeout(ms)`.
 * Sobald der Aufrufer ein eigenes Abbruch-Signal übergab — und der Wizard tut
 * das immer —, wurde der Timeout stillschweigend **verworfen**. Eine
 * überlastete Overpass-Instanz antwortete nicht, das Promise löste nie auf,
 * und die Analyse blieb bei „Satellitenbild geladen" stehen. Der vorgesehene
 * Rückfall auf Annahmen konnte nicht greifen, weil dafür ein Fehlschlag nötig
 * ist — und es gab keinen, nur Warten.
 *
 * Die Lehre steckt im Namen: eine Frist ist keine Alternative zum Abbruch des
 * Aufrufers, sondern kommt **zusätzlich**. Beides muss gelten, immer.
 */

/**
 * Verbindet das Signal des Aufrufers mit einer Frist. Beide können abbrechen;
 * keines hebt das andere auf.
 *
 * `AbortSignal.any` gibt es erst ab neueren Browsern, deshalb der Rückfall auf
 * eine Handverdrahtung — eine externe Anfrage ohne Frist wäre genau der Fehler,
 * den dieses Modul verhindern soll.
 */
export function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout

  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([signal, timeout])

  const ac = new AbortController()
  const abort = (reason: unknown) => { if (!ac.signal.aborted) ac.abort(reason) }
  if (signal.aborted) abort(signal.reason)
  else signal.addEventListener('abort', () => abort(signal.reason), { once: true })
  if (timeout.aborted) abort(timeout.reason)
  else timeout.addEventListener('abort', () => abort(timeout.reason), { once: true })
  return ac.signal
}

/**
 * Eine Zusage mit Frist. Läuft die Frist ab, wird `fallback` geliefert statt
 * weiter zu warten.
 *
 * Das ist die eigentliche Garantie der Quellen-Schicht, und sie gehört
 * hierher — **nicht** in den Transport. Ein Transport ist austauschbar (HTTP,
 * Edge Function, Fixture); säße die Frist nur dort, könnte jede neue
 * Implementierung die Pipeline wieder einfrieren. Auf Quellen-Ebene gilt sie
 * für alle.
 */
export async function withinBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  fallback: T,
  ms: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  const deadline = withDeadline(callerSignal, ms)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(deadline),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
    ])
  } catch (err) {
    if (isCallerAbort(callerSignal)) throw err
    return fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Ob ein Abbruch vom Aufrufer kam (dann muss er durchgereicht werden) oder von
 * der Frist (dann ist er ein normaler Fehlschlag und der Rückfall greift).
 */
export function isCallerAbort(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted
}

/** Fristen der einzelnen Quellen. Bewusst knapp — ein Wizard darf nicht warten. */
export const SOURCE_BUDGET_MS = {
  /** Kataster: kleine GeoJSON-Antworten, antwortet normalerweise unter 1 s. */
  alkis: 7_000,
  /**
   * Overpass auf dem kritischen Pfad der Analyse. Gemessen braucht die enge
   * Abfrage ~2 s; 8 s lassen Luft, ohne den Wizard hängen zu lassen.
   */
  overpass: 12_000,
  /**
   * Overpass für die 3D-Nachbarschaft. Läuft im Hintergrund mit sichtbarem
   * Rückfall, darf deshalb warten — die große Abfrage braucht gemessen ~8,5 s.
   */
  overpassWorld: 25_000,
} as const
