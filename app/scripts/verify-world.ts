/**
 * verify-world.ts — wie vollständig ist die nachgebaute Nachbarschaft?
 *
 * Die 3D-Nachbarschaft stand bisher allein auf OpenStreetMap. Das ist eine
 * Freiwilligenerfassung: in gut gemappten Innenstädten nahezu vollständig, in
 * einem Wohngebiet lückenhaft. Fehlende Häuser fallen dabei nicht als Fehler
 * auf — dort ist einfach Wiese, und Wiese sieht plausibel aus.
 *
 * Dieses Skript stellt beide Quellen für denselben Ort nebeneinander und macht
 * die Lücke zu einer Zahl.
 *
 *     npm run verify:world
 */

import { worldAlkisSource, WORLD_LIMITS } from '../src/lib/composer/sources/alkis'
import { worldOsmSource } from '../src/lib/composer/sources/overpass'
import { extractCadastreBuildings, extractParcels, parcelAtPoint } from '../src/lib/composer/resolvers/alkisResolver'
import { extractBuildings, extractRoads } from '../src/lib/composer/resolvers/osmResolver'
import { worldBuildingsFromCadastre, withoutOwnParcel } from '../src/lib/composer/resolvers/alkisWorld'
import { plainFrame, polygonToLocal } from '../src/lib/composer/frame'
import type { GeoPoint } from '../src/lib/composer/types'

const SITES: { name: string; at: GeoPoint }[] = [
  { name: 'Kolpingstr. 9, Borghorst', at: { lat: 52.122957, lng: 7.396185 } },
]

const RADIUS_M = 240
let failures = 0
const check = (ok: boolean, msg: string) => { if (!ok) { failures++; console.log(`    ✗ ${msg}`) } }

for (const site of SITES) {
  console.log(`\n══ ${site.name}`)
  const frame = plainFrame(site.at)
  const reference = { x: 0, y: 0 }

  const t0 = Date.now()
  const [osmSite, alkisSite] = await Promise.all([
    worldOsmSource.fetchSite(site.at),
    worldAlkisSource.fetchSite(site.at, RADIUS_M, undefined, WORLD_LIMITS),
  ])
  console.log(`  beide Quellen nach ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)

  const osmBuildings = osmSite ? extractBuildings(osmSite, frame, undefined) : []
  const roads = osmSite ? extractRoads(osmSite, frame, reference) : []
  const cadastre = alkisSite ? extractCadastreBuildings(alkisSite) : []
  const fromCadastre = worldBuildingsFromCadastre(cadastre, frame, osmBuildings, reference)

  console.log(`  OpenStreetMap  ${String(osmBuildings.length).padStart(4)} Gebäude, ${roads.length} Straßen`)
  console.log(`  ALKIS          ${String(fromCadastre.length).padStart(4)} Gebäude (amtlich, vollständig)`)

  if (osmBuildings.length > 0) {
    console.log(`  → ${(fromCadastre.length / osmBuildings.length).toFixed(1)}× so viele Baukörper wie aus OSM allein\n`)
  } else {
    console.log('  → OSM lieferte diesmal nichts; das Kataster trägt die Nachbarschaft allein\n')
  }

  check(fromCadastre.length > 0, 'Kataster liefert keine Gebäude')
  if (roads.length === 0) {
    console.log('  ! Overpass hat nichts geliefert (der Dienst ist notorisch wackelig).')
    console.log('    Genau dafür ist die Nachbarschaft entkoppelt: die Katastergebäude')
    console.log('    bleiben trotzdem stehen, statt zugunsten einer erfundenen Siedlung')
    console.log('    verworfen zu werden.')
  }
  // Die Wahl im Hook: die reichere Quelle gewinnt.
  const chosen = fromCadastre.length > osmBuildings.length ? 'ALKIS' : 'OSM'
  check(chosen === 'ALKIS', `unerwartet ${chosen} gewählt`)
  console.log(`  ✓ gewählt: ${chosen}`)

  // Wie viele Katastergebäude konnten Geschosse von OSM erben?
  const withLevels = fromCadastre.filter((b) => b.levels !== undefined).length
  console.log(`  ✓ Geschosszahl von OSM übernommen: ${withLevels} von ${fromCadastre.length}`)

  // Alles auf dem eigenen Flurstück muss raus, sonst steht es doppelt: der
  // Plan zeichnet Haus, Garage und Schuppen bereits selbst.
  const parcel = alkisSite ? parcelAtPoint(site.at, extractParcels(alkisSite)) : undefined
  check(!!parcel, 'eigenes Flurstück nicht gefunden')
  if (parcel) {
    const outline = polygonToLocal(frame, parcel.ring)
    const cleaned = withoutOwnParcel(fromCadastre, outline)
    const removed = fromCadastre.filter((b) => !cleaned.includes(b))
    check(removed.length >= 1, 'kein einziger eigener Baukörper aussortiert')
    console.log(`  ✓ eigenes Flurstück: ${parcel.label ?? '—'}`)
    console.log(`  ✓ ${removed.length} eigene Baukörper aussortiert: ` +
      removed.map((b) => `${b.areaSqm} m²`).join(', '))
    console.log(`    (Entfernungen zum Anker: ${removed.map((b) => `${b.distanceM} m`).join(', ')})`)
    console.log(`  → Nachbarschaft: ${cleaned.length} Gebäude`)
  }

  // Grobe Plausibilität: ein Wohngebiet mit 240 m Radius hat viele Gebäude,
  // aber nicht tausende. Schlägt das an, ist vermutlich das Limit erreicht.
  check(fromCadastre.length < WORLD_LIMITS.buildings,
    `${fromCadastre.length} Gebäude — Limit ${WORLD_LIMITS.buildings} vermutlich erreicht, Nachbarschaft abgeschnitten`)

  const areas = fromCadastre.map((b) => b.areaSqm).sort((a, b) => a - b)
  const med = areas[Math.floor(areas.length / 2)]
  console.log(`  Flächen: kleinste ${areas[0]} m², Median ${med} m², größte ${areas[areas.length - 1]} m²`)
}

console.log(failures === 0 ? '\n✓ alle Prüfungen bestanden' : `\n✗ ${failures} Prüfung(en) fehlgeschlagen`)
process.exit(failures === 0 ? 0 : 1)
