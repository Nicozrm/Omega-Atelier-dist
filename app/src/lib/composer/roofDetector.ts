/**
 * roofDetector.ts — the RoofDetector.
 *
 * Estimates roof form (gable / hip / flat / pent), pitch, ridge orientation and
 * ridge/eaves heights from the building's footprint and storey count. The ridge
 * runs along the footprint's longer axis, as it does on most homes.
 */

import type {
  AnalysisContext,
  BuildingFeature,
  DetectorModule,
  RoofFeature,
  RoofShape,
} from './types'

function bboxOf(poly: BuildingFeature['footprint']) {
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  return {
    w: Math.max(...xs) - Math.min(...xs),
    d: Math.max(...ys) - Math.min(...ys),
  }
}

export function detectRoof(building: BuildingFeature, ctx: AnalysisContext): RoofFeature {
  const rng = ctx.rng.fork(0x524f4f46) // 'ROOF'
  const { w, d } = bboxOf(building.footprint)

  // `roof:shape` ist in OSM oft getaggt. Dann ist die Dachform gemessen — die
  // Neigung bleibt trotzdem eine Ableitung, denn die kennt OSM praktisch nie.
  const taggedShape = ctx.osm?.own?.roofShape

  // Shape mix: gable dominates, hips and flats common, pent rare. Taller homes
  // skew pitched; single-storey modern boxes skew flat.
  const roll = rng.next()
  let shape: RoofShape
  if (taggedShape) {
    shape = taggedShape
  } else if (building.stories >= 2) {
    shape = roll < 0.5 ? 'gable' : roll < 0.8 ? 'hip' : roll < 0.94 ? 'flat' : 'pent'
  } else {
    shape = roll < 0.4 ? 'flat' : roll < 0.72 ? 'gable' : roll < 0.9 ? 'hip' : 'pent'
  }

  const pitchDeg = shape === 'flat' ? rng.range(1, 4) : shape === 'pent' ? rng.range(8, 18) : rng.range(28, 45)
  const eavesHeightM = building.heightM
  // Ridge rise from the pitch over the shorter span (the gable spans the short side).
  const span = Math.min(w, d)
  const rise = shape === 'flat' ? 0.3 : (span / 2) * Math.tan((pitchDeg * Math.PI) / 180)
  const ridgeHeightM = Math.round((eavesHeightM + rise) * 10) / 10

  // Ridge runs along the longer footprint axis: 0° = north–south ridge.
  const orientationDeg = w >= d ? 90 : 0

  return {
    shape,
    pitchDeg: Math.round(pitchDeg),
    ridgeHeightM,
    eavesHeightM,
    orientationDeg,
    confidence: taggedShape ? 0.96 : 0.35,
    shapeProvenance: taggedShape ? 'measured' : 'assumed',
  }
}

export const RoofDetector: DetectorModule<BuildingFeature, RoofFeature> = {
  id: 'roof-detector',
  label: 'Dach',
  run: detectRoof,
}
