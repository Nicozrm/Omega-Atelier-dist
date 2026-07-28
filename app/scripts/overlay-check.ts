/**
 * Zeichnet die Katasterumrisse in denselben lokalen Rahmen wie den
 * Luftbild-Boden. Passen beide aufeinander, stimmt die Geometrie und der
 * Fehler liegt in der 3D-Szene. Passen sie nicht, ist er hier.
 */
import { writeFileSync } from 'node:fs'
import { worldAlkisSource, WORLD_LIMITS } from '../src/lib/composer/sources/alkis'
import { extractCadastreBuildings, extractParcels, parcelAtPoint } from '../src/lib/composer/resolvers/alkisResolver'
import { worldBuildingsFromCadastre } from '../src/lib/composer/resolvers/alkisWorld'
import { plainFrame, polygonToLocal } from '../src/lib/composer/frame'
import { orthophotoCandidates } from '../src/lib/composer/sources/dop'

const at = { lat: 52.122957, lng: 7.396185 }
const GROUND = 240          // Bodenkante in Metern
const PX = 1400             // Bildkante

const frame = plainFrame(at)
const site = await worldAlkisSource.fetchSite(at, GROUND / 2 + 40, undefined, WORLD_LIMITS)
if (!site) throw new Error('kein ALKIS')
const buildings = worldBuildingsFromCadastre(extractCadastreBuildings(site), frame, [], { x: 0, y: 0 })
const parcel = parcelAtPoint(at, extractParcels(site))

// Luftbild herunterladen und lokal ablegen.
const photo = orthophotoCandidates({ at, groundSizeM: GROUND, pixels: PX })[0]
const buf = Buffer.from(await (await fetch(photo.url)).arrayBuffer())
writeFileSync(process.argv[2] + '/dop.jpg', buf)

// Lokale Meter → Bildpixel. x nach Osten, y nach Süden; das Bild hat Norden
// oben, also wächst die Bildzeile mit y. Genau diese Zuordnung wird geprüft.
const s = PX / GROUND
const toPx = (p: { x: number; y: number }) => [PX / 2 + p.x * s, PX / 2 + p.y * s]

const poly = (pts: { x: number; y: number }[], stroke: string, w: number, fill = 'none') =>
  `<polygon points="${pts.map(toPx).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="${w}"/>`

const shapes = buildings
  .filter((b) => Math.abs(b.centre.x) < GROUND / 2 && Math.abs(b.centre.y) < GROUND / 2)
  .map((b) => poly(b.footprint, '#00e5ff', 2))
  .join('\n')
const parcelShape = parcel ? poly(polygonToLocal(frame, parcel.ring), '#ffd400', 3, 'rgba(255,212,0,0.14)') : ''

writeFileSync(process.argv[2] + '/overlay.html', `<!doctype html><meta charset=utf-8>
<style>body{margin:0;background:#111} .wrap{position:relative;width:${PX}px;height:${PX}px}
img,svg{position:absolute;inset:0;width:${PX}px;height:${PX}px}</style>
<div class=wrap><img src="dop.jpg"><svg viewBox="0 0 ${PX} ${PX}">
<circle cx="${PX/2}" cy="${PX/2}" r="6" fill="#ff2d55"/>
${parcelShape}
${shapes}
</svg></div>`)
console.log(`  ${buildings.length} Katastergebäude, Bild ${(buf.length/1024).toFixed(0)} kB`)
console.log(`  Flurstück: ${parcel?.label ?? '—'}`)
