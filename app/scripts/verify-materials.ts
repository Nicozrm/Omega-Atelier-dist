/**
 * verify-materials.ts — welcher Kanal fehlt welcher Oberfläche?
 *
 * Zweimal in Folge war dieselbe Lücke die Ursache dafür, dass Material „zu
 * generisch" wirkte, und beide Male war sie im Code unsichtbar, weil ein
 * Material ohne Rauheitskarte vollkommen gültig ist und einfach nur flach
 * aussieht:
 *
 *   • aussen: Klinker, Ziegel, Pflaster und Asphalt hatten Farbe und Relief,
 *     aber einen festen Glanzwert über die ganze Fläche;
 *   • innen: Böden, Wände und Metalle hatten längst eine Rauheitskarte —
 *     Polster, Leder, Leinen und Teppich dagegen keine einzige.
 *
 * Ein Compiler findet das nie. Deshalb liest dieses Skript die
 * Materialdefinitionen selbst und zählt die Kanäle. Es ist bewusst eine
 * Quelltextprüfung und kein Laufzeittest: die Materialien entstehen aus
 * Canvas-Texturen und brauchen einen Browser, die Frage „hat dieses Material
 * eine Rauheitskarte" steht aber wörtlich im Quelltext.
 *
 * Geprüft werden zwei Dinge:
 *
 *  1. **Vollständigkeit.** Ein Material mit Farbtextur sollte auch Relief und
 *     Glanz variieren. Fehlt der Glanz, wird es gemeldet.
 *  2. **Physik.** Glas ist ein Dielektrikum. `metalness > 0` auf einer Scheibe
 *     ist kein Geschmacksfehler, sondern ein falsches Materialmodell: three
 *     färbt dann die Spiegelung mit der Grundfarbe ein und lässt den diffusen
 *     Anteil verschwinden. Genau das hat die Fenster der Nachbarschaft zu
 *     flachen dunklen Rechtecken gemacht.
 *
 * Ausführen:  npx vite-node@2 scripts/verify-materials.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FILES = [
  'src/components/3d/ThreeDView.tsx',
  'src/components/3d/Neighbourhood3D.tsx',
].map((f) => resolve(here, '..', f))

interface Mat {
  file: string
  name: string
  body: string
}

/** Zerlegt eine Datei in ihre Materialdefinitionen, über Klammerzählung. */
function materialsIn(file: string, src: string): Mat[] {
  const out: Mat[] = []
  const re = /new THREE\.Mesh(?:Standard|Physical)Material\(\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    const body = src.slice(m.index, i)
    // Der Name steht davor als `bezeichner:` oder `const bezeichner =`.
    const before = src.slice(Math.max(0, m.index - 120), m.index)
    const named = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before.replace(/\s+$/, '') + ' ')
      ?? /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before)
    out.push({
      file: file.split('/').pop()!,
      name: named?.[1] ?? `@${src.slice(0, m.index).split('\n').length}`,
      body,
    })
  }
  return out
}

const has = (b: string, ...keys: string[]) => keys.some((k) => b.includes(k))

let failures = 0
const missingRough: Mat[] = []
const metallicGlass: Mat[] = []
let withMap = 0, withRough = 0, withNormal = 0, total = 0

for (const path of FILES) {
  const src = readFileSync(path, 'utf8')
  for (const mat of materialsIn(path, src)) {
    total++
    const b = mat.body
    const map = has(b, 'map:')
    const normal = has(b, 'normalMap:')
    // `rough(...)` ist der Helfer, der roughnessMap setzt.
    const rough = has(b, 'roughnessMap:', '...rough(')
    if (map) withMap++
    if (rough) withRough++
    if (normal) withNormal++

    // Reine Leucht- oder Farbmaterialien brauchen keine Karten.
    if (map && !rough && !has(b, 'emissiveIntensity', 'transmission')) missingRough.push(mat)

    if (/glass|scheibe|window/i.test(mat.name)) {
      const met = /metalness:\s*([\d.]+)/.exec(b)
      const ternary = /metalness:\s*[^,\n]*\?\s*[\d.]+\s*:\s*([\d.]+)/.exec(b)
      const worst = Math.max(Number(met?.[1] ?? 0), Number(ternary?.[1] ?? 0))
      if (worst > 0) metallicGlass.push(mat)
    }
  }
}

console.log(`══ ${total} Materialien in ${FILES.length} Dateien`)
console.log(`   mit Farbtextur   ${withMap}`)
console.log(`   mit Normalkarte  ${withNormal}`)
console.log(`   mit Rauheit      ${withRough}`)

console.log('\n══ Physik — Glas ist ein Dielektrikum (metalness = 0)')
if (metallicGlass.length === 0) {
  console.log('  ✓ keine metallische Scheibe')
} else {
  failures++
  for (const g of metallicGlass) console.log(`  ✗ ${g.file} · ${g.name}`)
}

console.log('\n══ Vollständigkeit — Farbtextur ohne Glanzvariation')
if (missingRough.length === 0) {
  console.log('  ✓ jede texturierte Oberfläche variiert ihren Glanz')
} else {
  console.log(`  ⚠ ${missingRough.length} Oberfläche(n) ohne Rauheitskarte:`)
  for (const g of missingRough) console.log(`      ${g.file} · ${g.name}`)
  console.log('  (kein Fehler, aber jede davon liest sich als bemalte Ebene)')
}

console.log(`\n${failures === 0 ? '✓ Keine Materialfehler.' : `✗ ${failures} Materialfehler.`}`)
process.exit(failures === 0 ? 0 : 1)
