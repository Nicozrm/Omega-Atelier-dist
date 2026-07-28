import { runAnalysis } from '../src/lib/composer/analysisEngine'
import { esriProvider } from '../src/lib/composer/onlineProvider'
import type { GeoPoint } from '../src/lib/composer/types'

const C: GeoPoint = { lat: 52.12307, lng: 7.39610 }
const mPerLat = 111_320, mPerLng = mPerLat * Math.cos((C.lat * Math.PI) / 180)
const rot = (18 * Math.PI) / 180
// Grob um das Haus gezeichnet — bewusst kleiner und schiefer als das Flurstück.
const drawn: GeoPoint[] = ([[-9,-7],[11,-7],[11,8],[-9,8]] as [number,number][]).map(([x,y]) => {
  const rx = x*Math.cos(rot)-y*Math.sin(rot), ry = x*Math.sin(rot)+y*Math.cos(rot)
  return { lat: C.lat - ry/mPerLat, lng: C.lng + rx/mPerLng }
})
const view = { center: C, zoom: 19 }

for (const [label, opts] of [
  ['nur Zeichnung (ALKIS aus)', { provider: esriProvider, alkis: null, osm: null }],
  ['mit ALKIS + OSM',           { provider: esriProvider }],
] as const) {
  const s = await runAnalysis({ view, tap: C, polygon: drawn }, opts as any)
  const p = s.property
  console.log(`══ ${label}`)
  console.log('  Grundstück:', `${p.widthM} × ${p.depthM} m, ${p.areaSqm} m² (${p.provenance.geometry})`)
  console.log('  Amtlich   :', p.parcelLabel ?? '—')
  console.log('  Straße    :', p.streetSide, `(${p.provenance.streetSide})`, p.streetName ?? '')
  console.log('  Gebäude   :', `${s.building.areaSqm} m², ${s.building.footprint.length} Punkte (${s.building.provenance.footprint})`)
  console.log('  Konfidenz :', s.confidence.overall, JSON.stringify(s.confidence.provenance))
}
