/**
 * verify-lod2.ts — echte Höhen statt hochgerechneter.
 *
 * Prüft die ganze Kette gegen den Dienst: Abruf, CityJSON-Umrechnung (die
 * Koordinaten stehen als ganze Zahlen und liegen ohne `transform` bei etwa
 * 0,0), Dachform-Schlüssel und Plausibilität der Höhen.
 *
 *     npm run verify:lod2
 */
import { lod2Source, roofShapeFromCode } from '../src/lib/composer/sources/lod2'

const at = { lat: 52.122957, lng: 7.396185 }
let failures = 0
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`  ✗ ${msg}`) } }

const t0 = Date.now()
const list = await lod2Source.fetchAround(at)
console.log(`  ${list.length} Gebäude mit gemessener Höhe nach ${((Date.now()-t0)/1000).toFixed(1)} s\n`)
check(list.length > 50, `nur ${list.length} Gebäude`)
if (list.length === 0) { console.log('  (Dienst antwortete nicht — er läuft regelmäßig in 502er)'); process.exit(1) }

// Liegen die Schwerpunkte wirklich im abgefragten Gebiet? Ohne `transform`
// lägen sie bei (0,0) — der Fehler, den diese Prüfung fängt.
const far = list.filter((b) => Math.abs(b.at.lat - at.lat) > 0.01 || Math.abs(b.at.lng - at.lng) > 0.02)
check(far.length === 0, `${far.length} Gebäude außerhalb des Gebiets — transform vergessen?`)
console.log(`  ✓ alle Schwerpunkte im Gebiet (z. B. ${list[0].at.lat.toFixed(5)}, ${list[0].at.lng.toFixed(5)})`)

const hs = list.map((b) => b.heightM).sort((a, b) => a - b)
const med = hs[hs.length >> 1]
console.log(`  Höhen: min ${hs[0]} m, Median ${med} m, max ${hs[hs.length-1]} m`)
check(hs[0] > 1 && hs[hs.length-1] < 120, 'unplausible Höhen')
check(med > 4 && med < 25, `Median ${med} m unplausibel für ein Wohngebiet`)

const shapes = new Map<string, number>()
for (const b of list) shapes.set(b.roofShape ?? '—', (shapes.get(b.roofShape ?? '—') ?? 0) + 1)
console.log('  Dachformen:', [...shapes].map(([k, v]) => `${k} ${v}`).join(', '))
check((shapes.get('gable') ?? 0) > 0, 'kein einziges Satteldach — Schlüssel falsch?')

// Der Schlüssel selbst.
const cases: [number, string][] = [[1000,'flat'],[2100,'pent'],[3100,'gable'],[3200,'hip'],[3300,'hip']]
for (const [code, want] of cases) {
  const got = roofShapeFromCode(code)
  check(got === want, `Code ${code} → ${got}, erwartet ${want}`)
}
console.log('  ✓ Dachform-Schlüssel stimmt für Flach-, Pult-, Sattel-, Walm- und Krüppelwalmdach')

// Vergleich mit dem bisherigen Verfahren: Geschosse aus Fläche, Höhe daraus.
const abgeleitet = 2 * 2.85 + 0.4
console.log(`\n  bisher abgeleitet: ${abgeleitet.toFixed(1)} m für jedes zweigeschossige Haus`)
const spread = hs[Math.floor(hs.length*0.9)] - hs[Math.floor(hs.length*0.1)]
console.log(`  gemessen: ${spread.toFixed(1)} m Spanne zwischen dem 10. und 90. Perzentil`)
check(spread > 3, 'die gemessenen Höhen streuen kaum — dann brächte LoD2 wenig')

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
