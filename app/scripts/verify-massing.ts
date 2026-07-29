/**
 * verify-massing.ts — wie viele verschiedene Häuser stehen wirklich da?
 *
 * „Zu generisch" ist ein Eindruck, aber er hat eine messbare Ursache: zu wenig
 * verschiedene Formen für zu viele Gebäude. Und diese Zahl lässt sich zählen,
 * statt sie zu schätzen.
 *
 * Gezählt wird die **Silhouette** — die Merkmale, die man aus dreissig Metern
 * unterscheiden kann, bevor Farbe oder Textur überhaupt lesbar sind:
 * Firstrichtung, Dachform, Geschosszahl, Anbau ja/nein, Zahl der
 * Fensterachsen, Lage der Haustür. Zwei Häuser mit gleicher Signatur sehen bis
 * auf den Farbton gleich aus, egal wie gut die Materialien sind.
 *
 * Der Ausgangspunkt: **jedes** erzeugte Haus war giebelständig, hatte genau
 * einen Baukörper, genau zwei Fenster je Geschoss an fest einprogrammierten
 * Stellen und die Haustür exakt mittig. Die Signatur bestand damit faktisch aus
 * Dachform × Geschosszahl — eine Handvoll Varianten für eine ganze Siedlung.
 *
 * Ausführen:  npx vite-node@2 scripts/verify-massing.ts
 */

import { generateNeighbourhood } from '../src/lib/world'
import type { CityStyle } from '../src/lib/world/cityStyle'

const STYLES: CityStyle[] = ['de', 'ska', 'usa', 'med']
let failures = 0

function check(ok: boolean, what: string, detail: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what.padEnd(26)} ${detail}`)
  if (!ok) failures++
}

function share(list: string[]): string {
  const counts = new Map<string, number>()
  for (const v of list) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${Math.round((n / list.length) * 100)}%`)
    .join(', ')
}

for (const style of STYLES) {
  const world = generateNeighbourhood({
    style, seed: 0xbeef, centre: { x: 0, z: 0 },
    widthM: 20, depthM: 16, detail: 'high',
  })
  const houses = world.houses
  if (houses.length === 0) { check(false, style, 'keine Häuser erzeugt'); continue }

  console.log(`\n══ ${style.toUpperCase()} — ${houses.length} Gebäude`)

  const ridges = houses.map((h) => h.ridge)
  const gableShare = ridges.filter((r) => r === 'gable').length / houses.length
  check(
    gableShare > 0.1 && gableShare < 0.9,
    'Firstrichtung gemischt',
    share(ridges) + '  (vorher: gable 100 %)',
  )

  const wings = houses.filter((h) => h.wing).length / houses.length
  check(wings > 0.12, 'Anbauten', `${Math.round(wings * 100)} % haben einen zweiten Baukörper (vorher 0 %)`)

  check(
    new Set(houses.map((h) => h.bays)).size >= 2,
    'Fensterachsen',
    share(houses.map((h) => String(h.bays))) + '  (vorher: immer 2)',
  )

  check(
    new Set(houses.map((h) => h.doorBay)).size >= 2,
    'Türlage',
    share(houses.map((h) => `Achse ${h.doorBay}`)) + '  (vorher: immer mittig)',
  )

  /*
   * Die eigentliche Zahl.
   *
   * Wie viele *unterscheidbare* Häuser stehen in der Siedlung, gemessen an
   * dem, was man von weitem sieht? Der Anteil an der Gesamtzahl sagt, wie oft
   * sich ein Haus wiederholt: bei 100 % ist jedes anders, bei 5 % steht
   * derselbe Bau zwanzigmal.
   */
  const sig = houses.map((h) => [
    h.ridge, h.roof, h.stories, h.wing ? `w${Math.round(h.wing.widthM)}${h.wing.roof}` : '-',
    h.bays, h.doorBay, h.garage, h.dormer ? 'g' : '', h.balcony ? 'b' : '',
  ].join('/'))
  const distinct = new Set(sig).size
  const ratio = distinct / houses.length
  check(
    ratio > 0.35,
    'verschiedene Silhouetten',
    `${distinct} von ${houses.length} = ${Math.round(ratio * 100)} % (häufigste Form ${
      Math.round((Math.max(...[...new Set(sig)].map((x) => sig.filter((y) => y === x).length)) / houses.length) * 100)
    } % der Häuser)`,
  )
}

console.log(`\n${failures === 0 ? '✓ Die Nachbarschaft wiederholt sich nicht mehr.' : `✗ ${failures} Befund(e).`}`)
process.exit(failures === 0 ? 0 : 1)
