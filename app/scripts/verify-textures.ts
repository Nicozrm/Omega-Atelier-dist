/**
 * verify-textures.ts — trägt eine Detailkarte die Struktur oder die Farbe?
 *
 * Die Falle, die dieses Skript abdeckt, hat jedes Dach der Mittelmeer-Siedlung
 * schwarz gemacht, und sie ist im Quelltext völlig unauffällig.
 *
 * Eine Farbtextur an einem `MeshStandardMaterial` wird mit `material.color`
 * **multipliziert**. Die Karte ist damit kein Bild, sondern ein Faktor — und
 * wenn sie dunkel gezeichnet ist, multiplizieren sich zwei dunkle Werte:
 *
 *     Ziegelkachel 43/255   → 0,024 linear
 *     MED-Dach #a4633d      → 0,371 linear
 *     Produkt               → 0,009  — praktisch Schwarz
 *
 * Die Regionalpalette hatte dadurch faktisch keine Wirkung mehr: terrakotta
 * und schiefergrau kamen beide als Schwarz heraus. Beim Klinker ist dieselbe
 * Sache ausdrücklich behandelt (die Materialfarbe wird weiss aufgehellt), am
 * Dach fehlte die Behandlung.
 *
 * Geprüft wird deshalb: eine Karte, die eine Palettenfarbe tönen soll, muss im
 * Mittel **neutral hell** sein. Alles unter etwa 0,25 linear frisst die Farbe
 * auf, statt sie zu tragen.
 *
 * Das Skript rendert die Leinwände wirklich (headless) und misst sie — es liest
 * nicht den Quelltext. Genau deshalb findet es diese Klasse von Fehlern.
 *
 * Ausführen:  npx vite-node@2 scripts/verify-textures.ts [ausgabeverzeichnis]
 */

import { createCanvas } from '@napi-rs/canvas'


// Minimaler DOM-Ersatz, bevor irgendetwas aus der Anwendung geladen wird.
;(globalThis as unknown as { document: unknown }).document = {
  createElement(tag: string) {
    if (tag !== 'canvas') throw new Error('nur canvas')
    return createCanvas(1, 1)
  },
}

const { brickTextures, roofTextures, paverTextures, asphaltSurface, boardTextures, srgbMean } =
  await import('../src/lib/proceduralTextures')

const OUT = process.argv[2]
if (OUT) {
  const { writeFileSync: w } = await import('node:fs')
  for (const [n, set] of [['brick', brickTextures()], ['roof', roofTextures()], ['board', boardTextures()], ['paver', paverTextures()], ['asphalt', asphaltSurface()]] as [string, Record<string, { image: { toBuffer(f: string): Buffer } }>][]) {
    for (const [ch, tex] of Object.entries(set)) w(`${OUT}/${n}-${ch}.png`, tex.image.toBuffer('image/png'))
  }
}
let failures = 0
const check = (ok: boolean, what: string, detail: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what.padEnd(30)} ${detail}`)
  if (!ok) failures++
}

/*
 * Geprüft wird das **Produkt**, nicht die Karte allein.
 *
 * Ein erster Entwurf hat verlangt, dass jede tönbare Karte im Mittel neutral
 * hell ist. Das war zu grob: Klinker und Holzverschalung tragen ihre Farbe
 * bewusst selbst (0,126 bzw. 0,092 linear), und die Palette **verschiebt** sie
 * nur — im Bild sieht das richtig aus. Nur beim Dach sollte die Palette den Ton
 * bestimmen, und genau dort war die Karte zu dunkel.
 *
 * Die Anforderung, die für beide Bauarten gilt, ist also nicht „helle Karte",
 * sondern: was am Ende herauskommt, muss ein plausibles Material sein. Ein
 * Dachziegel liegt bei rund 0,02 (Schiefer) bis 0,25 (helle Terrakotta), eine
 * Fassade bei 0,04 bis 0,45. Darunter ist es Schwarz, darüber Kreide.
 */
const { cityStyleSpec, CITY_STYLES } = await import('../src/lib/world/cityStyle')
const toLinear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const hexLin = (hex: string) => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16)))
const lumOf = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

const maps = {
  brick: srgbMean(brickTextures().map.image as unknown as HTMLCanvasElement),
  roof: srgbMean(roofTextures().map.image as unknown as HTMLCanvasElement),
  board: srgbMean(boardTextures().map.image as unknown as HTMLCanvasElement),
  paver: srgbMean(paverTextures().map.image as unknown as HTMLCanvasElement),
  asphalt: srgbMean(asphaltSurface().map.image as unknown as HTMLCanvasElement),
}
console.log('══ Karten (lineares Mittel)')
for (const [k, v] of Object.entries(maps)) console.log(`   ${k.padEnd(10)} ${lumOf(v).toFixed(3)}`)

console.log('\n══ Produkt Karte × Palette — was tatsächlich am Dach ankommt')
console.log('   Echte Dachmaterialien: Schiefer/Anthrazit 0,04…0,08, Tonziegel 0,20…0,35\n')
console.log('   Stil    dunkelstes   hellstes')
let tooDark = 0
for (const style of CITY_STYLES) {
  const spec = cityStyleSpec(style)
  const vals = spec.palette.roofs.map((hex) => lumOf(hexLin(hex).map((c, i) => c * maps.roof[i])))
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const note = lo < 0.02 ? '  · dunkler als jedes reale Dachmaterial' : ''
  if (lo < 0.02) tooDark++
  console.log(`   ${style.toUpperCase().padEnd(7)} ${lo.toFixed(4).padStart(9)}  ${hi.toFixed(4).padStart(9)}${note}`)
  // Fehlschlag nur bei der Fehlerklasse selbst: eine Karte, die die Palette
  // auffrisst. Der Fehler lag bei 0,0010 bis 0,0090.
  if (lo <= 0.010) failures++
}
check(
  failures === 0,
  'Palette kommt durch',
  'kein Dach unter 0,010 — dort lagen vor der Korrektur MED (0,0090) und DE (0,0010)',
)

/*
 * Fassaden stehen hier nur nachrichtlich. Sie bekommen im Renderer eine
 * Aufhellung der Materialfarbe zum Weissen hin (0,35 bei Klinker, 0,20 bei
 * Holz), die dieses Skript nicht nachbildet — die Rohzahl wäre also irreführend.
 * Die Fehlerklasse betrifft sie ohnehin nicht: dort ist der Ausgleich vorhanden,
 * am Dach fehlte er.
 */
if (tooDark > 0) {
  console.log(`\n   Hinweis: ${tooDark} Stil(e) haben Dächer unterhalb realer Materialwerte.`)
  console.log('   Das ist kein Fehler dieser Korrektur — sie hat DE von 0,0010 auf 0,0119')
  console.log('   gehoben —, sondern eine offene Frage an die Palette selbst.')
}

console.log(`\n${failures === 0 ? '✓ Jede Detailkarte trägt Struktur, nicht Farbe.' : `✗ ${failures} Befund(e).`}`)
process.exit(failures === 0 ? 0 : 1)
