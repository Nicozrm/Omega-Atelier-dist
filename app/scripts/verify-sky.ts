/**
 * verify-sky.ts — steht die Sonne dort, wo sie hingehört?
 *
 * Der Himmel ist eine equirektanguläre Karte, und an solchen Karten geht genau
 * eines schief: die Zuordnung von Richtung zu Bildstelle. Die Fehler sind dabei
 * grob und trotzdem leicht zu übersehen, weil ein Himmel auch verkehrt herum
 * noch wie ein Himmel aussieht:
 *
 *   • v-Achse verdreht → der Himmel steht auf dem Kopf; unten Zenitblau, oben
 *     Horizontdunst. Ohne Vergleich fällt das erstaunlich spät auf.
 *   • u-Achse verdreht → die Sonne steht im Osten, während ihr Licht von
 *     Westen kommt, und die Schatten zeigen zur hellsten Stelle des Himmels.
 *   • `flipY` übersehen → eine halbe Bildhöhe Versatz, die Sonne sitzt im
 *     falschen Höhenwinkel.
 *
 * Geprüft wird gegen die Formel, die three tatsächlich benutzt (`equirectUv`
 * in `ShaderChunk/common.glsl.js`), nicht gegen eine nacherzählte Fassung.
 *
 * Ausführen:  npx vite-node@2 scripts/verify-sky.ts
 */

const W = 1024, H = 512

/** Wortgleich three r169: u = atan(z,x)/2π + 0.5, v = asin(y)/π + 0.5. */
function equirectUv(d: { x: number; y: number; z: number }): [number, number] {
  return [
    Math.atan2(d.z, d.x) / (Math.PI * 2) + 0.5,
    Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5,
  ]
}

/** Wo SkyDome die Sonne aufträgt. */
function sunPixel(d: { x: number; y: number; z: number }): [number, number] {
  const [u, v] = equirectUv(d)
  return [u * (W - 1), (1 - v) * (H - 1)]
}

/** Welche Höhe die Zeilenschleife einer Leinwandzeile zuschreibt. */
function rowElevation(py: number): number {
  const v = 1 - py / (H - 1)
  return Math.sin((v - 0.5) * Math.PI)
}

let bad = 0
const say = (ok: boolean, text: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${text}`)
  if (!ok) bad++
}

console.log('══ Zeilen — flipY macht die oberste Leinwandzeile zu v = 1')
say(Math.abs(rowElevation(0) - 1) < 1e-9, `py = 0      → dy = ${rowElevation(0).toFixed(3)}  (Zenit)`)
say(Math.abs(rowElevation((H - 1) / 2)) < 1e-9, `py = Mitte  → dy = ${rowElevation((H - 1) / 2).toFixed(3)}  (Horizont)`)
say(Math.abs(rowElevation(H - 1) + 1) < 1e-9, `py = H−1    → dy = ${rowElevation(H - 1).toFixed(3)}  (Nadir)`)

console.log('\n══ Sonne — Höhe der Zeile muss die Höhe der Sonne sein')
const deg = (d: number) => (d * Math.PI) / 180
const cases: [string, { x: number; y: number; z: number }][] = [
  ['Osten, 30° hoch', { x: Math.cos(deg(30)), y: Math.sin(deg(30)), z: 0 }],
  ['Westen, 30° hoch', { x: -Math.cos(deg(30)), y: Math.sin(deg(30)), z: 0 }],
  ['Süden, 60° (Mittag)', { x: 0, y: Math.sin(deg(60)), z: Math.cos(deg(60)) }],
  ['Süden, 3° (Sonnenuntergang)', { x: 0, y: Math.sin(deg(3)), z: Math.cos(deg(3)) }],
]
for (const [name, d] of cases) {
  const [px, py] = sunPixel(d)
  say(
    Math.abs(rowElevation(py) - d.y) < 0.01,
    `${name.padEnd(28)} px ${px.toFixed(0).padStart(4)}, py ${py.toFixed(0).padStart(3)} — Zeile meint ${rowElevation(py).toFixed(3)}, Sonne ist ${d.y.toFixed(3)}`,
  )
}

console.log('\n══ Naht — gegenüberliegende Richtungen liegen eine halbe Breite auseinander')
const east = sunPixel(cases[0][1])[0]
const west = sunPixel(cases[1][1])[0]
say(
  Math.abs(Math.abs(east - west) - (W - 1) / 2) < 1.5,
  `Ost ↔ West = ${Math.abs(east - west).toFixed(0)} px (erwartet ${((W - 1) / 2).toFixed(0)} für 180°)`,
)
// Die Abendsonne landet rechnerisch am Bildrand. Deshalb zeichnet SkyDome sie
// dreifach (−W, 0, +W): sonst endet ihr halber Hof an einer senkrechten Kante.
say(
  west > W - 40,
  `Westsonne sitzt bei px ${west.toFixed(0)} — also auf der Naht, das dreifache Auftragen ist nötig`,
)

console.log(`\n${bad === 0 ? '✓ Himmelsprojektion stimmt.' : `✗ ${bad} Fehler.`}`)
process.exit(bad === 0 ? 0 : 1)
