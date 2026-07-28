/**
 * Slice 2 gegen echte Daten: Kolpingstraße, Steinfurt-Borghorst.
 * Vergleicht denselben Lauf mit und ohne OSM-Quelle.
 */
import { runAnalysis } from '../src/lib/composer/analysisEngine'
import { esriProvider } from '../src/lib/composer/onlineProvider'
import type { GeoPoint } from '../src/lib/composer/types'

const CENTER: GeoPoint = { lat: 52.12307, lng: 7.39610 }

/** Ein realistisches, leicht gedrehtes Grundstück um das Gebäude. */
const mPerLat = 111_320
const mPerLng = mPerLat * Math.cos((CENTER.lat * Math.PI) / 180)
const rot = (18 * Math.PI) / 180
const drawn: GeoPoint[] = ([[-14, -11], [16, -11], [16, 12], [-14, 12]] as [number, number][])
  .map(([x, y]) => {
    const rx = x * Math.cos(rot) - y * Math.sin(rot)
    const ry = x * Math.sin(rot) + y * Math.cos(rot)
    return { lat: CENTER.lat - ry / mPerLat, lng: CENTER.lng + rx / mPerLng }
  })

const view = { center: CENTER, zoom: 19 }

console.log('══ ohne OSM (nur Annahmen) ══')
const off = await runAnalysis({ view, tap: CENTER, polygon: drawn }, { provider: esriProvider, osm: null })
report(off)

console.log('\n══ mit OSM ══')
const on = await runAnalysis({ view, tap: CENTER, polygon: drawn }, { provider: esriProvider })
report(on)

function report(scene: Awaited<ReturnType<typeof runAnalysis>>) {
  const p = scene.property
  console.log('Grundstück :', `${p.widthM} × ${p.depthM} m, ${p.areaSqm} m²`,
    `| Straße: ${p.streetSide} (${p.provenance.streetSide})`,
    p.streetName ? `→ ${p.streetName}` : '')
  console.log('Gebäude    :', `${scene.building.areaSqm} m², ${scene.building.stories} Geschosse,`,
    `Traufe ${scene.building.heightM} m, ${scene.building.footprint.length} Umriss-Punkte`)
  console.log('Dach       :', scene.roof.shape, `(${scene.roof.shapeProvenance})`,
    `${scene.roof.pitchDeg}°, First ${scene.roof.ridgeHeightM} m`)
  console.log('Konfidenz  :', scene.confidence.overall, JSON.stringify(scene.confidence.byObject))
  console.log('Herkunft   :', JSON.stringify(scene.confidence.provenance))
  console.log('Gebäude-Hk :', JSON.stringify(scene.building.provenance))
}
