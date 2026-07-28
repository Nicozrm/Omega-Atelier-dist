/**
 * verify-structures.ts — steht auf dem Grundstück mehr als ein Haus?
 *
 * Anlass: an der Kolpingstraße 9 in Borghorst kennt das Kataster sechs
 * Baukörper. Die Analyse hat davon genau einen übernommen und den Rest vom
 * Generator erfinden lassen — Garagenzeile und Schuppen standen im Modell
 * woanders als in der Wirklichkeit, sahen aber aus wie eine Messung.
 *
 * Dieses Skript läuft gegen die echten Dienste und prüft dreierlei:
 *
 *  1. Das Hauptgebäude ist das richtige (das größte Nicht-Nebengebäude).
 *  2. Die Nebengebäude fehlen nicht — Anzahl und Flächen stammen aus dem
 *     Kataster, nicht aus dem Zufallsgenerator.
 *  3. Ohne Kataster bleibt der prozedurale Weg intakt (kein Rückschritt für
 *     Orte außerhalb NRW).
 *
 *     npm run verify:structures
 */

import { runAnalysis } from '../src/lib/composer/analysisEngine'
import { esriProvider } from '../src/lib/composer/onlineProvider'
import { buildScene } from '../src/lib/composer/sceneBuilder'
import type { GeoPoint } from '../src/lib/composer/types'

const C: GeoPoint = { lat: 52.122957, lng: 7.396185 } // Kolpingstr. 9, Flur 017, Flst 738
const view = { center: C, zoom: 19 }

let failures = 0
const check = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failures++
}

for (const [label, opts] of [
  ['mit Kataster', { provider: esriProvider }],
  ['ohne Kataster (prozedural)', { provider: esriProvider, alkis: null, osm: null }],
] as const) {
  const s = await runAnalysis({ view, tap: C, polygon: [] }, opts as never)
  const parts = s.building.parts
  const main = parts.filter((p) => p.kind === 'main')
  const extra = parts.filter((p) => p.kind !== 'main' && p.kind !== 'terrace' && p.kind !== 'balcony')

  console.log(`\n══ ${label}`)
  console.log(`  Grundstück ${s.property.areaSqm} m² (${s.property.provenance.geometry})  ${s.property.parcelLabel ?? '—'}`)
  console.log(`  Hauptgebäude ${s.building.areaSqm} m², ${s.building.stories} Geschosse (${s.building.provenance.footprint})`)
  for (const p of parts) {
    const a = areaOf(p.polygon)
    console.log(`    · ${p.kind.padEnd(12)} ${a.toFixed(0).padStart(4)} m²  h=${p.heightM.toFixed(1)} m  conf ${p.confidence.toFixed(2)}`)
  }

  check(main.length === 1, `genau ein Hauptvolumen (${main.length})`)

  if (label === 'mit Kataster') {
    // Zur Erwartung: eine bbox-Abfrage über 40 m um den Grundstücksmittelpunkt
    // liefert sechs Baukörper (174, 116, 76, 44, 20, 14 m²). Auf Flurstück 738
    // selbst stehen davon **zwei** — Wohnhaus und Garagenzeile; der Rest gehört
    // den Nachbargrundstücken. Genau diese Unterscheidung ist der Zweck der
    // Punkt-im-Polygon-Prüfung, und die Zahl hier prüft sie mit: würde die
    // Filterung wegfallen, stünden plötzlich fünf Nebengebäude im Modell.
    check(s.property.provenance.geometry === 'measured', 'Grundstücksgrenze ist vermessen')
    check(extra.length === 1, `genau ein Nebengebäude auf dem Flurstück (${extra.length})`)
    check(
      extra.every((p) => p.confidence >= 0.9),
      'Nebengebäude tragen Mess-Konfidenz, nicht Generator-Konfidenz',
    )
    // Der entscheidende Unterschied zum Generator: die Umrisse sind keine
    // gewürfelten Rechtecke, sondern die tatsächlichen Katasterpolygone.
    const shaped = extra.filter((p) => p.polygon.length > 4).length
    check(shaped > 0, `Umriss stammt aus dem Kataster, nicht aus einem Rechteck (${shaped} mit >4 Ecken)`)
    // Die Garagenzeile aus den Straßenfotos: rund 76 m², also mehrere Boxen.
    check(
      extra.some((p) => areaOf(p.polygon) > 50),
      'die Garagenzeile ist dabei (>50 m²)',
    )
  }

  // Der Grundriss muss jedes Nebengebäude als eigenen Raum führen.
  const draft = buildScene(s)
  const rooms = draft.floors.flatMap((f) => f.rooms).filter((r) =>
    /Garage|Carport|Nebengebäude/.test(r.name))
  check(
    rooms.length === extra.length,
    `Grundriss führt jedes Nebengebäude als Raum (${rooms.length} von ${extra.length}): ${rooms.map((r) => r.name).join(', ') || '—'}`,
  )
}

function areaOf(poly: { x: number; y: number }[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
