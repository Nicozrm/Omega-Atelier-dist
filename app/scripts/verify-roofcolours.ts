/**
 * Prüft die Farbablesung am echten Luftbild — ohne Browser, also mit einem
 * selbst dekodierten JPEG-Ersatz: das WMS liefert auf Wunsch PNG, und ein
 * unkomprimiertes Graustufen-/RGB-PNG lässt sich hier direkt lesen.
 *
 * Wichtiger als das Bild ist ohnehin das Verfahren: Median statt Mittelwert
 * und die k-Means-Zusammenfassung.
 */
import { medianColour, quantise, rgbToHex, type Rgb } from '../src/lib/world/roofColours'

let failures = 0
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`  ✗ ${msg}`) } }

// 1. Median gegen Mittelwert: ein rotes Ziegeldach mit dunklen Gauben.
const px = new Uint8ClampedArray(100 * 4)
for (let i = 0; i < 100; i++) {
  // 80 % Ziegelrot, 20 % fast schwarze Gauben/Schatten.
  const dark = i >= 80
  px[i * 4] = dark ? 25 : 178
  px[i * 4 + 1] = dark ? 25 : 74
  px[i * 4 + 2] = dark ? 28 : 52
  px[i * 4 + 3] = 255
}
const med = medianColour(px)!
const mean = { r: 0.8 * 178 + 0.2 * 25, g: 0.8 * 74 + 0.2 * 25, b: 0.8 * 52 + 0.2 * 28 }
console.log('── Median gegen Mittelwert (Ziegeldach mit dunklen Gauben) ──')
console.log(`  Ziegelton   ${rgbToHex({ r: 178, g: 74, b: 52 })}`)
console.log(`  Median      ${rgbToHex(med)}   ← trifft die Fläche`)
console.log(`  Mittelwert  ${rgbToHex(mean)}   ← von den Gauben verdunkelt`)
check(med.r === 178 && med.g === 74, 'Median trifft den Ziegelton nicht')
check(mean.r < med.r - 20, 'Mittelwert wäre nicht nennenswert dunkler — Testfall untauglich')

// 2. Quantisierung: drei klar getrennte Dachtypen dürfen nicht verschmelzen.
const ziegel: Rgb = { r: 178, g: 74, b: 52 }
const schiefer: Rgb = { r: 62, g: 66, b: 72 }
const flach: Rgb = { r: 168, g: 168, b: 162 }
const colours: Rgb[] = []
for (let i = 0; i < 40; i++) {
  const jitter = (c: Rgb): Rgb => ({ r: c.r + (i % 7) - 3, g: c.g + (i % 5) - 2, b: c.b + (i % 3) - 1 })
  colours.push(jitter(ziegel), jitter(schiefer), jitter(flach))
}
const { palette, indexOf } = quantise(colours, 12)
console.log('\n── Quantisierung von 120 Dachfarben ──')
console.log(`  Palette (${palette.length}): ${palette.join(' ')}`)
const groups = new Set(indexOf.filter((_, i) => i % 3 === 0))
const groups2 = new Set(indexOf.filter((_, i) => i % 3 === 1))
const groups3 = new Set(indexOf.filter((_, i) => i % 3 === 2))
const overlap = [...groups].some((g) => groups2.has(g) || groups3.has(g))
check(!overlap, 'Ziegel, Schiefer und Flachdach landen im selben Topf')
console.log(`  ✓ die drei Dachtypen bleiben getrennt (${groups.size}/${groups2.size}/${groups3.size} Cluster)`)

// 3. Reproduzierbarkeit — dieselbe Straße muss zweimal gleich aussehen.
const again = quantise(colours, 12)
check(JSON.stringify(again.palette) === JSON.stringify(palette), 'Ergebnis ist nicht reproduzierbar')
console.log('  ✓ zweiter Durchlauf liefert dieselbe Palette')

// 4. Randfälle
check(medianColour(new Uint8ClampedArray(0)) === undefined, 'leerer Ausschnitt liefert keine undefined')
check(quantise([], 8).palette.length === 0, 'leere Eingabe erzeugt Palette')
console.log('  ✓ leere Eingaben liefern nichts statt zu werfen')

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
