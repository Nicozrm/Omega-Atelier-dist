import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { installChunkRecovery } from '@/lib/chunkRecovery'
import { initQuality } from '@/lib/quality'
import { installSwFreshness } from '@/lib/swFreshness'
import { installMotion } from '@/lib/motion'
import { installSound } from '@/lib/sound'
import '@/styles/index.css'

/**
 * Build-Stempel. Ohne ihn lässt sich nicht beantworten, ob ein Gerät den
 * aktuellen Stand sieht — genau die Frage, die nach jedem Deploy aufkommt,
 * weil der Service Worker das alte Bundle noch minutenlang weiterliefert.
 * `__OMEGA_BUILD__` in der Konsole beantwortet sie in fünf Sekunden.
 */
const BUILD_STAMP = {
  builtAt: __BUILD_TIME__,
  commit: __BUILD_COMMIT__,
}
;(window as unknown as Record<string, unknown>).__OMEGA_BUILD__ = BUILD_STAMP
console.info(`%cOMEGA Atelier%c ${BUILD_STAMP.commit} · ${BUILD_STAMP.builtAt}`,
  'font-weight:600;color:#C7A24E', 'color:inherit')

// Resolve the render quality tier once, before anything reads it.
initQuality()
// Recover from stale lazy-chunk loads after a PWA redeploy (blank/black screen).
installChunkRecovery()
// Converge long-open tabs/PWAs to the newest deploy (periodic SW update check
// + one controlled reload when a new service worker takes over).
installSwFreshness()
// Upgrade the --spring-* motion tokens to physical damped-oscillator curves.
installMotion()
// Arm the micro-auditory feedback (unlocks on the first user gesture).
installSound()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <Analytics />
      <SpeedInsights />
    </ErrorBoundary>
  </React.StrictMode>,
)
