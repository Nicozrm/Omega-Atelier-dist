/**
 * verify-dop.ts — stimmt der Maßstab des Luftbild-Bodens?
 *
 * Der gefährliche Fehler hier ist nicht „kein Bild", sondern „falsches Bild":
 * Web-Mercator streckt Distanzen um 1/cos(φ), auf 52° Nord um rund 62 %. Wer
 * das übersieht, bekommt einen Ausschnitt, der wie ein korrektes Luftbild
 * aussieht und trotzdem um 62 % verzerrt auf der Szene liegt — Häuser neben
 * ihren Umrissen, Einfahrt im Vorgarten.
 *
 * Deshalb prüft dieses Skript die Umrechnung gegen eine unabhängige Quelle:
 * die Bounding-Box der Anfrage wird zurück nach WGS84 gerechnet und ihre
 * Kantenlänge mit der Haversine-Formel gemessen. Kommt dabei die bestellte
 * Bodenkante heraus, stimmt der Maßstab.
 *
 *     npm run verify:dop
 */

import {
  coverageProbeUrl, mercatorHalfSpan, orthophotoCandidates, toMercator, MAX_WMS_PX,
} from '../src/lib/composer/sources/dop'
import type { GeoPoint } from '../src/lib/composer/types'

const MERC_R = 20037508.342789244

/** Zurück nach WGS84 — bewusst unabhängig von `toMercator` implementiert. */
function fromMercator(x: number, y: number): GeoPoint {
  return {
    lng: (x / MERC_R) * 180,
    lat: (Math.atan(Math.exp((y / MERC_R) * Math.PI)) * 360) / Math.PI - 90,
  }
}

/** Große-Kreis-Distanz in Metern. */
function haversine(a: GeoPoint, b: GeoPoint): number {
  const R = 6371008.8
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const SITES: { name: string; at: GeoPoint; expectSource?: string }[] = [
  { name: 'Kolpingstr. 9, Borghorst', at: { lat: 52.122957, lng: 7.396185 }, expectSource: 'nw-dop' },
  { name: 'Hannover', at: { lat: 52.3759, lng: 9.7320 }, expectSource: 'ni-dop20' },
  { name: 'Wien (ohne Befliegung)', at: { lat: 48.2082, lng: 16.3738 } },
]

let failures = 0
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`    ✗ ${msg}`) } }

console.log('── Maßstab der Anfrage ──\n')
for (const size of [120, 240, 480]) {
  const at = SITES[0].at
  const half = mercatorHalfSpan(size, at.lat)
  const c = toMercator(at)
  // Kante der Bounding-Box, zurückgerechnet und unabhängig gemessen.
  const w = haversine(fromMercator(c.x - half, c.y), fromMercator(c.x + half, c.y))
  const h = haversine(fromMercator(c.x, c.y - half), fromMercator(c.x, c.y + half))
  const errW = Math.abs(w - size) / size, errH = Math.abs(h - size) / size
  check(errW < 0.005, `Breite ${w.toFixed(1)} m statt ${size} m`)
  check(errH < 0.01, `Höhe ${h.toFixed(1)} m statt ${size} m`)
  // Gegenprobe: ohne die cos(φ)-Korrektur wäre es grob daneben.
  const naive = haversine(fromMercator(c.x - size / 2, c.y), fromMercator(c.x + size / 2, c.y))
  console.log(`  bestellt ${String(size).padStart(3)} m  →  gemessen ${w.toFixed(1)} × ${h.toFixed(1)} m` +
              `   (ohne cos-Korrektur wären es ${naive.toFixed(1)} m, also ${((naive / size - 1) * 100).toFixed(0)} %)`)
}

console.log('\n── Auswahl über gemessene Deckung ──\n')
for (const site of SITES) {
  const candidates = orthophotoCandidates({ at: site.at, groundSizeM: 240, pixels: 1024 })
  console.log(`  ${site.name}`)
  console.log(`    Kandidaten (fein→grob): ${candidates.map((c) => c.source.id).join(', ') || '—'}`)

  // Dieselbe Reihenfolge wie im Browser: erst der winzige Transparenz-Abzug,
  // dann erst das große Bild. Hier steht die Antwortgröße für den Alphakanal.
  let chosen: string | undefined
  for (const c of candidates) {
    const probe = await fetch(coverageProbeUrl(c, site.at), { signal: AbortSignal.timeout(45_000) })
    const bytes = (await probe.arrayBuffer()).byteLength
    // Eine 32-px-PNG ohne Inhalt ist praktisch leer; mit Inhalt deutlich größer.
    const covered = bytes > 900
    console.log(`      ${covered ? '✓' : '·'} ${c.source.id.padEnd(10)} Abzug ${String(bytes).padStart(5)} B  ${covered ? 'zuständig' : 'außerhalb'}`)
    if (covered && !chosen) chosen = c.source.id
  }

  if (!site.expectSource) {
    check(!chosen, `${site.name}: unerwartet zuständig (${chosen})`)
    console.log(`    → kein Luftbild, erzeugter Boden bleibt  ${chosen ? '✗' : '✓'}\n`)
    continue
  }
  check(chosen === site.expectSource, `${site.name}: gewählt ${chosen ?? 'keiner'}, erwartet ${site.expectSource}`)
  if (chosen !== site.expectSource) { console.log('') ; continue }

  const photo = candidates.find((c) => c.source.id === chosen)!
  const res = await fetch(photo.url, { signal: AbortSignal.timeout(45_000) })
  const buf = await res.arrayBuffer()
  const type = res.headers.get('content-type') ?? '?'
  check(res.status === 200 && type.startsWith('image/'), `${site.name}: ${res.status} ${type}`)
  check(buf.byteLength > 20_000, `${site.name}: nur ${buf.byteLength} B`)
  console.log(`    → ${photo.source.label}  ${photo.pixels}px  ${photo.cmPerPixel} cm/px  ${(buf.byteLength / 1024).toFixed(0)} kB\n`)
}

console.log('\n── Deckelung ──')
const huge = orthophotoCandidates({ at: SITES[0].at, groundSizeM: 240, pixels: 99_999 })[0]
check(huge?.pixels === MAX_WMS_PX, `Pixelzahl nicht gedeckelt: ${huge?.pixels}`)
console.log(`  ✓ 99999 px angefordert → ${huge?.pixels} px (Dienstgrenze)`)

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
