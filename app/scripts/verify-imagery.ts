/**
 * verify-imagery.ts — beweist, dass die Bildquellen wirklich Bilder liefern.
 *
 * Geprüft wird nicht „ist der Dienst online", sondern die Kette, die im
 * Browser läuft: Ort → Ebenenstapel → Kachel-URL aus `imagery.ts` → Antwort →
 * Auswahl der genannten Quelle.
 *
 * Zwei Fallen, die dieses Skript gezielt stellt:
 *
 *  1. Eine falsch gebaute WMS-Anfrage antwortet mit **HTTP 200** und einem
 *     XML-Fehler statt eines Bildes. Nur der Content-Type verrät es.
 *  2. Ein Dienst antwortet auch außerhalb seines Gebiets mit 200 — dann aber
 *     mit einer leeren, transparenten Kachel. Genau daran ist ein erster
 *     Entwurf gescheitert: Hannover liegt innerhalb der von NRW gemeldeten
 *     Hülle, also hätte die 10-cm-Ebene gewonnen und nichts gezeigt.
 *
 * Der Browser unterscheidet voll/leer durch Abtasten des Alphakanals
 * (`hasPixels` in `MapCanvas`). Hier steht dafür die Antwortgröße: eine leere
 * 512-px-PNG ist rund ein Kilobyte, ein Luftbild zwei Größenordnungen mehr.
 *
 *     npm run verify:imagery
 */

import {
  esriImagery, imageryStack, topLayer, tileBounds3857, REGIONAL_DOP,
} from '../src/lib/composer/imagery'
import { latToTileY, lonToTileX, tileGroundMeters } from '../src/lib/composer/onlineProvider'
import type { GeoPoint } from '../src/lib/composer/types'

const PLACES: { name: string; at: GeoPoint; expect: string }[] = [
  { name: 'Borghorst (NRW)', at: { lat: 52.12307, lng: 7.39610 }, expect: 'nw-dop' },
  // Liegt in der NRW-Hülle, gehört aber zu Niedersachsen — der Härtefall.
  { name: 'Hannover (NI)', at: { lat: 52.3759, lng: 9.7320 }, expect: 'ni-dop20' },
  { name: 'Dresden (SN)', at: { lat: 51.0504, lng: 13.7373 }, expect: 'sn-dop20' },
  { name: 'Wien (AT)', at: { lat: 48.2082, lng: 16.3738 }, expect: 'esri-world-imagery' },
]

const ZOOM = 19
/** Ab hier ist eine Kachel sicher kein transparentes Nichts. */
const FILLED_BYTES = 8 * 1024

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  ✗ ${msg}`) }

async function tile(url: string): Promise<{ status: number; type: string; bytes: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  const buf = await res.arrayBuffer()
  return { status: res.status, type: res.headers.get('content-type') ?? '?', bytes: buf.byteLength }
}

console.log('── Bildquellen ──')
for (const dop of REGIONAL_DOP) {
  console.log(`  ${dop.label.padEnd(32)} ${(dop.groundResolutionM * 100).toFixed(0).padStart(3)} cm  ·  ${dop.licence}`)
}
console.log(`  ${esriImagery.label.padEnd(32)} ~${(esriImagery.groundResolutionM * 100).toFixed(0)} cm  ·  global, Rückfall\n`)

for (const place of PLACES) {
  const stack = imageryStack(place.at)
  console.log(`── ${place.name} ──`)
  console.log(`  Stapel (unten→oben): ${stack.map((l) => l.id).join(' → ')}`)

  const covered = new Set<string>()
  for (const layer of stack) {
    const z = Math.min(layer.maxZoom, ZOOM)
    const x = Math.floor(lonToTileX(place.at.lng, z))
    const y = Math.floor(latToTileY(place.at.lat, z))
    try {
      const r = await tile(layer.tileUrl(z, x, y))
      if (r.status !== 200 || !r.type.startsWith('image/')) {
        fail(`${layer.id}: ${r.status} ${r.type} — kein Bild`)
        continue
      }
      const filled = !layer.partial || r.bytes >= FILLED_BYTES
      if (filled) covered.add(layer.id)
      const cmPerPx = (tileGroundMeters(place.at.lat, z) / layer.tilePx) * 100
      console.log(
        `  · ${layer.id.padEnd(20)} z${z} ${String(r.bytes / 1024 | 0).padStart(4)} kB  ` +
        `${cmPerPx.toFixed(1).padStart(5)} cm/px  ${filled ? 'Inhalt' : 'leer (außerhalb)'}`,
      )
    } catch (err) {
      fail(`${layer.id}: Abruf fehlgeschlagen — ${(err as Error).message}`)
    }
  }

  const best = topLayer(stack, covered)
  if (best.id === place.expect) console.log(`  ✓ genannte Quelle: ${best.id}\n`)
  else fail(`genannte Quelle ${best.id}, erwartet ${place.expect}\n`)
}

// Die Kachelgrenzen sind die Stelle, an der ein Vorzeichenfehler stillschweigend
// das falsche Stück Erde liefert — deshalb eine Zahlenprobe: die vier Kacheln
// um den Nullpunkt bei z1 müssen die vier Quadranten sein.
console.log('── Kachelgrenzen (EPSG:3857) ──')
const quads = [
  ['0/0', tileBounds3857(1, 0, 0), 'NW'],
  ['1/0', tileBounds3857(1, 1, 0), 'NO'],
  ['0/1', tileBounds3857(1, 0, 1), 'SW'],
  ['1/1', tileBounds3857(1, 1, 1), 'SO'],
] as const
for (const [t, bbox, quad] of quads) {
  const [minX, minY, maxX, maxY] = bbox.split(',').map(Number)
  const ok = (quad.includes('W') ? maxX <= 0 : minX >= 0) && (quad.startsWith('N') ? minY >= 0 : maxY <= 0)
  if (ok) console.log(`  ✓ z1/${t} ${quad}  ${bbox}`)
  else fail(`z1/${t} ${quad} ${bbox}`)
}

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
