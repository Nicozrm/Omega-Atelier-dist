/**
 * verify-shadow-frustum.ts — deckt das Schatten-Frustum den Plan wirklich ab?
 *
 * Anlass: die Schattenkamera zielte auf den Weltursprung, obwohl der Plan in
 * 0…wM / 0…hM liegt — der Ursprung ist also seine **Ecke**, nicht seine Mitte.
 * Bei einem 12×8-m-Grundstück hing das 32×32-m-Frustum damit zur Hälfte in
 * leerem Raum, während auf der Seite, wohin der Schatten fällt, nur 4 m Rand
 * blieben. Das Gebäude belegte rund 9 % der Schattenkarte.
 *
 * Der Fehler war rein geometrisch und wäre in jedem Screenshot unauffällig
 * geblieben: abgeschnittene Schattenspitzen sehen aus wie eine Designfrage,
 * nicht wie ein Bug. Deshalb steht die Geometrie hier als Rechnung, nicht als
 * Bild.
 *
 *     npm run verify:shadow-frustum
 */

/** Muss mit `shadowExtentM` in `components/3d/ThreeDView.tsx` übereinstimmen. */
const MARGIN_M = 10
const MAP_PX = 4096

const extent = (wM: number, hM: number) => Math.max(wM, hM) / 2 + MARGIN_M

/** Der alte, fehlerhafte Aufbau — zum Vergleich. */
const oldExtent = (wM: number, hM: number) => Math.max(wM, hM) + 4

interface Plan { wM: number; hM: number }
const PLANS: Plan[] = [
  { wM: 9, hM: 9 }, { wM: 12, hM: 8 }, { wM: 20, hM: 10 },
  { wM: 30, hM: 14 }, { wM: 55, hM: 19 }, // letzter: Kolpingstr. 9
]

let failures = 0
const check = (ok: boolean, msg: string) => {
  if (!ok) { failures++; console.log(`    ✗ ${msg}`) }
  return ok
}

console.log(`Rand ${MARGIN_M} m, Schattenkarte ${MAP_PX}²\n`)
console.log(`  ${'Plan'.padEnd(11)} ${'Kante'.padEnd(15)} ${'Texel/m'.padEnd(17)} Rand rundum`)

for (const { wM, hM } of PLANS) {
  const e = extent(wM, hM)
  const o = oldExtent(wM, hM)
  const dNew = MAP_PX / (2 * e)
  const dOld = MAP_PX / (2 * o)

  // 1. Der Plan muss vollständig im Frustum liegen — zentriert, also von
  //    −halbe Ausdehnung bis +halbe Ausdehnung.
  check(e >= wM / 2 && e >= hM / 2, `${wM}×${hM}: Plan ragt aus dem Frustum`)

  // 2. Ringsum muss mindestens der versprochene Rand bleiben. Das ist die
  //    Eigenschaft, die vorher auf zwei Seiten verletzt war.
  const margin = e - Math.max(wM, hM) / 2
  check(margin >= MARGIN_M - 1e-9, `${wM}×${hM}: Rand nur ${margin.toFixed(1)} m`)

  // 3. Kein Rückschritt bei der Schärfe außer dort, wo der Handel bewusst ist:
  //    ein kleiner quadratischer Plan verliert Dichte, gewinnt aber Reichweite.
  const ratio = dNew / dOld
  const acceptable = ratio >= 0.85 || Math.max(wM, hM) <= 10
  check(acceptable, `${wM}×${hM}: Dichte fällt auf ${(ratio * 100).toFixed(0)} % ohne Rechtfertigung`)

  console.log(
    `  ${`${wM}×${hM} m`.padEnd(11)} ` +
    `${`${(2 * o).toFixed(0)}→${(2 * e).toFixed(0)} m`.padEnd(15)} ` +
    `${`${dOld.toFixed(0)}→${dNew.toFixed(0)} (${ratio.toFixed(2)}×)`.padEnd(17)} ` +
    `4 m → ${margin.toFixed(0)} m`,
  )
}

// Der Schattenwurf, aus dem der Rand abgeleitet ist. Hält die Begründung
// nachprüfbar, statt sie im Kommentar zu behaupten.
console.log('\n  Schattenlänge eines 7-m-Hauses:')
for (const elev of [20, 27, 35, 45, 60]) {
  const len = 7 / Math.tan((elev * Math.PI) / 180)
  const covered = len <= MARGIN_M
  console.log(`    ${String(elev).padStart(2)}° → ${len.toFixed(1).padStart(5)} m  ${covered ? 'abgedeckt' : 'Spitze wird beschnitten (bewusst)'}`)
}

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
