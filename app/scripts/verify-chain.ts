/**
 * verify-chain.ts — läuft den Weg, den der Benutzer wirklich geht.
 *
 * Warum es dieses Skript zusätzlich zu `verify-alkis` gibt: `verify-alkis`
 * prüft den **guten** Pfad. Es setzt `esriProvider` ein und übergibt ein
 * gezeichnetes Polygon. Beides umgeht genau die Stelle, an der die Kette
 * gerissen ist — der Standard-Anbieter ist der Offline-Anbieter, und die
 * meisten Läufe haben keine Zeichnung, sondern nur einen Tipp.
 *
 * Der Fehler, der dadurch monatelang unsichtbar blieb: `OfflineMapProvider`
 * hat `image.center` auf die Mitte einer **erfundenen** 26 × 34 m Rasterzelle
 * gesetzt. Daran hängt jede echte Quelle. Bis zu 21 m neben dem Tipp gefragt,
 * fand `parcelAtPoint` kein Flurstück, und die Analyse fiel lautlos auf ihr
 * eigenes Raster zurück: „Grundstück 1166 m², alles geschätzt, Konfidenz 33 %"
 * — obwohl das Kataster in 1,4 s die amtlichen 1044 m² geliefert hätte.
 *
 * Deshalb prüft dieses Skript **nicht**, ob die Dienste antworten (das tut
 * `verify-alkis`), sondern ob die Antwort im Ergebnis **ankommt**. Es hat
 * genau eine Behauptung:
 *
 *   Wo Kataster vorliegt, darf im Ergebnis nichts „geschätzt" stehen,
 *   was gemessen verfügbar war.
 *
 * Ausführen:  npx vite-node@2 scripts/verify-chain.ts
 * Rückgabe:   0 = Kette hält, 1 = irgendwo bricht sie
 */

import { runAnalysis } from '../src/lib/composer/analysisEngine'
import { defaultMapProvider } from '../src/lib/composer/mapProvider'
import { esriProvider } from '../src/lib/composer/onlineProvider'
import { alkisSource } from '../src/lib/composer/sources/alkis'
import { haversineMeters } from '../src/lib/composer/geo'
import type { GeoPoint } from '../src/lib/composer/types'

/** Kolpingstr. 9, Borghorst — amtlich 1044 m², Gemarkung Borghorst, Flur 017, Flurstück 738. */
const TAP: GeoPoint = { lat: 52.122957, lng: 7.396185 }
const EXPECTED_AREA_SQM = 1044
const EXPECTED_LABEL = /Borghorst/

const view = { center: TAP, zoom: 19 }
let failures = 0

function check(ok: boolean, what: string, detail: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${what.padEnd(28)} ${detail}`)
  if (!ok) failures++
}

/* ── 1. Der Anker ─────────────────────────────────────────────────────
 *
 * Zuerst die Stelle selbst, ohne Netz: verschiebt ein Anbieter den
 * Analysemittelpunkt gegenüber dem Tipp? Jeder Meter hier ist ein Meter, um
 * den nachher die falsche Parzelle gefragt wird.
 */
console.log('══ Anker: liegt der Analysemittelpunkt auf dem Tipp?')
for (const p of [defaultMapProvider, esriProvider]) {
  const img = p.capture(TAP, view)
  const off = haversineMeters(TAP, img.center)
  check(off < 0.5, p.id, `${off.toFixed(1)} m Versatz`)
}

/* ── 2. Die Quelle ────────────────────────────────────────────────────
 *
 * Antwortet das Kataster überhaupt, und antwortet es **vollständig**? Eine
 * abgeschnittene Seite ist der zweite lautlose Ausfall: HTTP 200, gültiges
 * GeoJSON, nur fehlt darin womöglich das eigene Flurstück.
 */
console.log('\n══ Quelle: antwortet das Kataster vollständig?')
const t0 = Date.now()
const site = await alkisSource.fetchSite(TAP, 90)
const took = Date.now() - t0
if (!site) {
  check(false, 'Kataster erreichbar', `nichts in ${took} ms — Rest des Laufs ist ohne Aussage`)
} else {
  check(true, 'Kataster erreichbar', `${site.parcels.length} Flurstücke, ${site.buildings.length} Gebäude in ${took} ms`)
  check(site.truncated.length === 0, 'Antwort vollständig', site.truncated.length ? site.truncated.join(', ') : 'nichts abgeschnitten')
}

/* ── 3. Das Ergebnis ──────────────────────────────────────────────────
 *
 * Der eigentliche Punkt. Ein blanker Tipp mit dem Standard-Anbieter, so wie
 * der Assistent ihn absetzt — keine Zeichnung, keine Sonderoption.
 */
console.log('\n══ Ergebnis: kommt das Gemessene im Twin an? (blanker Tipp, Standard-Anbieter)')
const scene = await runAnalysis({ view, tap: TAP })
const prop = scene.property

check(
  prop.provenance.geometry === 'measured',
  'Grundstücksgrenze',
  `${prop.provenance.geometry} — ${prop.areaSqm} m², ${prop.widthM} × ${prop.depthM} m`,
)
check(
  Math.abs(prop.areaSqm - EXPECTED_AREA_SQM) <= 5,
  'Fläche amtlich',
  `${prop.areaSqm} m² (erwartet ${EXPECTED_AREA_SQM} ± 5)`,
)
check(
  EXPECTED_LABEL.test(prop.parcelLabel ?? ''),
  'Flurstückskennung',
  prop.parcelLabel ?? '— (keine)',
)
check(
  scene.building.provenance.footprint === 'measured',
  'Gebäudeumriss',
  `${scene.building.provenance.footprint} — ${scene.building.areaSqm} m²`,
)
/*
 * Die Gesamtkonfidenz ist bewusst **kein** hoher Schwellwert.
 *
 * Sie soll nicht gut aussehen, sondern stimmen: Grenze und Umriss sind
 * vermessen (0,96), Dach, Gelände, Vegetation und Innenwände sind es nicht
 * (0,35 bzw. 0,21), und der Mittelwert daraus ist ehrlicherweise knapp unter
 * 60 %. Ein Lauf ganz ohne Kataster landete bei 33 % — das ist der Wert, gegen
 * den hier geprüft wird. Steigt die Zahl später, muss sie durch eine neue
 * Messung steigen (LoD2 für das Dach), nicht durch eine mildere Rechnung.
 */
console.log('\n══ Konfidenz je Objekt (was gemessen ist, und was nicht)')
for (const [k, v] of Object.entries(scene.confidence.byObject)) {
  const prov = scene.confidence.provenance[k as keyof typeof scene.confidence.provenance]
  console.log(`  ${k.padEnd(12)} ${String(Math.round(Number(v) * 100)).padStart(3)} %  ${prov}`)
}
check(
  scene.confidence.overall > 0.45,
  'Gesamtkonfidenz',
  `${Math.round(scene.confidence.overall * 100)} % (ohne Kataster waren es 33 %)`,
)

console.log(`\n${failures === 0 ? '✓ Die Kette hält.' : `✗ ${failures} Bruchstelle(n).`}`)
process.exit(failures === 0 ? 0 : 1)
