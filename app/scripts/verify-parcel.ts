/**
 * Verifies slice 1: the drawn parcel actually reaches the property feature,
 * and the oriented bounds beat the north-aligned box on a rotated plot.
 */
import { prepareParcel, runAnalysis } from '../src/lib/composer/analysisEngine'
import { detectProperty } from '../src/lib/composer/propertyDetector'
import { polygonAreaSqm, polygonBBox, orientedBounds, geoToLocal } from '../src/lib/composer/geo'
import { SeededRng } from '../src/lib/composer/rng'
import type { GeoPoint, SatelliteImage } from '../src/lib/composer/types'

/** A 24 × 16 m plot rotated 30° against north, near the screenshot's coords. */
const anchor: GeoPoint = { lat: 52.12307, lng: 7.39610 }
const mPerLat = 111_320
const mPerLng = mPerLat * Math.cos((anchor.lat * Math.PI) / 180)
const rot = (30 * Math.PI) / 180
const corners: [number, number][] = [[0, 0], [24, 0], [24, 16], [0, 16]]
const drawn: GeoPoint[] = corners.map(([x, y]) => {
  const rx = x * Math.cos(rot) - y * Math.sin(rot)
  const ry = x * Math.sin(rot) + y * Math.cos(rot)
  return { lat: anchor.lat - ry / mPerLat, lng: anchor.lng + rx / mPerLng }
})

const parcel = prepareParcel(drawn)
console.log('prepared parcel:', parcel && {
  areaSqm: parcel.areaSqm,
  widthM: parcel.widthM,
  depthM: parcel.depthM,
  orientationDeg: parcel.orientationDeg,
  points: parcel.polygon.length,
})
console.log('expected: area ≈ 384 m², sides 24 × 16 (order-independent)')

// What the naive north-aligned bounding box would have said.
const local = drawn.map((p) => geoToLocal({ lat: Math.max(...drawn.map(d => d.lat)), lng: Math.min(...drawn.map(d => d.lng)) }, p))
const bb = polygonBBox(local)
console.log('north-aligned bbox would be:',
  `${(bb.maxX - bb.minX).toFixed(1)} × ${(bb.maxY - bb.minY).toFixed(1)} m`,
  `(area ${((bb.maxX - bb.minX) * (bb.maxY - bb.minY)).toFixed(0)} m² vs true ${polygonAreaSqm(local).toFixed(0)} m²)`)
console.log('oriented bounds area:', orientedBounds(local).areaSqm.toFixed(0), 'm²')

// The detector must carry it through, with user provenance.
const image: SatelliteImage = {
  center: anchor, spanMeters: 150, seed: 12345, metersPerPixel: 0.23,
  provider: 'test', capturedAt: new Date().toISOString(),
}
const withParcel = detectProperty(image, { rng: new SeededRng(1), image, parcel: parcel! })
const without = detectProperty(image, { rng: new SeededRng(1), image })
console.log('\nwith drawn parcel :', {
  areaSqm: withParcel.areaSqm, w: withParcel.widthM, d: withParcel.depthM,
  conf: withParcel.confidence, prov: withParcel.provenance,
})
console.log('without (fallback):', {
  areaSqm: without.areaSqm, w: without.widthM, d: without.depthM,
  conf: without.confidence, prov: without.provenance,
})

// End to end through the engine.
const scene = await runAnalysis({ view: { center: anchor, zoom: 18 }, tap: anchor, polygon: drawn })
console.log('\nend-to-end property:', {
  areaSqm: scene.property.areaSqm,
  widthM: scene.property.widthM,
  depthM: scene.property.depthM,
  provenance: scene.property.provenance,
})
console.log('confidence report:', scene.confidence)

const noPoly = await runAnalysis({ view: { center: anchor, zoom: 18 }, tap: anchor })
console.log('\nwithout polygon, overall:', noPoly.confidence.overall,
  '| property:', noPoly.confidence.byObject.property,
  noPoly.confidence.provenance.property)
