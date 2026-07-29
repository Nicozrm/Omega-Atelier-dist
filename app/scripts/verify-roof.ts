/**
 * verify-roof.ts — deckt das Dach das Haus, und zeigt es nach oben?
 *
 * Das Walmdach war eine Vierkantpyramide: `coneGeometry` mit vier Seiten, um
 * 45° gedreht. Über einem Rechteck ist das in **beide** Richtungen zugleich
 * falsch, und zwar auf eine Art, die im Quelltext unauffällig aussieht — der
 * Umkreisradius wird aus der Diagonale gebildet, also misst die Grundkante
 * `hypot(W, D) · 0,52 · √2`. Auf einem 12 × 8 m Haus sind das 10,6 × 10,6 m:
 * über der langen Seite fehlt Dach, über der kurzen ragt es weit hinaus.
 *
 * Geprüft werden drei Dinge, die alle drei bei der alten Fassung fehlgeschlagen
 * wären:
 *
 *  1. **Deckung.** Die Traufkante muss den Grundriss umschliessen, mit
 *     Überstand — nicht darunter bleiben.
 *  2. **Wicklung.** Jede Dachfläche muss nach oben zeigen. Bei falscher
 *     Wicklung wird eine Fläche von innen beleuchtet und bleibt schwarz.
 *  3. **First.** Bei gleicher Neigung ringsum ist er genau `|W − D|` lang und
 *     läuft über die längere Achse. Bei quadratischem Grundriss wird er null —
 *     dann, und nur dann, ist ein Zeltdach richtig.
 *
 * Ausführen:  npx vite-node@2 scripts/verify-roof.ts
 */

import * as THREE from 'three'
import { hipRoofGeometry } from '../src/components/3d/Neighbourhood3D'

let failures = 0
const check = (ok: boolean, what: string, detail: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what.padEnd(24)} ${detail}`)
  if (!ok) failures++
}

/** Die alte Fassung, zum Vergleich: Grundkante einer 45°-Vierkantpyramide. */
const oldEdge = (w: number, d: number) => Math.hypot(w, d) * 0.52 * Math.SQRT2

const CASES: [string, number, number][] = [
  ['länglich  12 × 8', 12, 8],
  ['schmal    7 × 11', 7, 11],
  ['quadrat   10 × 10', 10, 10],
  ['sehr lang 16 × 6', 16, 6],
]

for (const [label, w, d] of CASES) {
  console.log(`\n══ ${label} m`)
  const rise = (Math.min(w, d) / 2) * Math.tan((32 * Math.PI) / 180)
  const g = hipRoofGeometry(w, d, rise)
  const pos = g.getAttribute('position')

  // 1. Deckung: Ausdehnung der Traufkante gegen den Grundriss.
  g.computeBoundingBox()
  const bb = g.boundingBox!
  const spanX = bb.max.x - bb.min.x
  const spanZ = bb.max.z - bb.min.z
  check(
    Math.abs(spanX - w) < 1e-6 && Math.abs(spanZ - d) < 1e-6,
    'Deckung',
    `${spanX.toFixed(2)} × ${spanZ.toFixed(2)} m (alt: ${oldEdge(w, d).toFixed(2)} × ${oldEdge(w, d).toFixed(2)})`,
  )

  // 2. Wicklung: jede Fläche muss nach oben zeigen.
  let down = 0
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3()
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i)
    b.fromBufferAttribute(pos, i + 1)
    c.fromBufferAttribute(pos, i + 2)
    ab.subVectors(b, a); ac.subVectors(c, a)
    n.crossVectors(ab, ac)
    if (n.y <= 1e-9) down++
  }
  check(down === 0, 'Wicklung', `${pos.count / 3} Dreiecke, ${down} zeigen nach unten`)

  // 3. First: Länge und Richtung.
  const top = bb.max.y
  const ridgePts: THREE.Vector3[] = []
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i)
    if (Math.abs(v.y - top) < 1e-6 && !ridgePts.some((p) => p.distanceTo(v) < 1e-6)) ridgePts.push(v)
  }
  const measured = ridgePts.length >= 2
    ? Math.max(...ridgePts.map((p) => Math.max(...ridgePts.map((q) => p.distanceTo(q)))))
    : 0
  const expected = Math.abs(w - d)
  check(
    Math.abs(measured - expected) < 1e-6,
    'Firstlänge',
    `${measured.toFixed(2)} m (erwartet |${w} − ${d}| = ${expected.toFixed(2)})`,
  )
  if (expected > 1e-6) {
    const alongX = ridgePts.length >= 2
      && Math.abs(ridgePts[0].x - ridgePts[1].x) > Math.abs(ridgePts[0].z - ridgePts[1].z)
    check(alongX === (w >= d), 'Firstrichtung', alongX ? 'über die x-Achse' : 'über die z-Achse')
  } else {
    console.log('    · kein First — quadratischer Grundriss, also zu Recht ein Zeltdach')
  }
}

console.log(`\n${failures === 0 ? '✓ Das Walmdach ist ein Walmdach.' : `✗ ${failures} Fehler.`}`)
process.exit(failures === 0 ? 0 : 1)
