/**
 * confidenceEngine.ts — how sure the run actually is.
 *
 * Previously this module *estimated* confidence: it read a number each detector
 * had made up (`0.9 + rng.range(0, 0.08)`) and averaged them. The result looked
 * like a measurement error bar and was nothing of the sort — a fabricated
 * parcel scored 94 %.
 *
 * Now the score is **derived from provenance** (see `provenance.ts`). A value
 * the user drew scores 1.0; something read from an authoritative source scores
 * ~0.96; something the generator invented scores ~0.35. Nothing here invents a
 * number any more — this module only weights and aggregates.
 *
 * The practical consequence is the point of the exercise: while the pipeline
 * still guesses the building, the roof and the interior, it now *says so*.
 */

import type {
  BuildingFeature,
  ConfidenceKey,
  ConfidenceReport,
  PropertyFeature,
  Rng,
  RoofFeature,
  TerrainProfile,
  VegetationFeature,
} from './types'
import { aggregateConfidence, assumed, type Provenance } from './provenance'

export interface ConfidenceInput {
  property: PropertyFeature
  building: BuildingFeature
  roof: RoofFeature
  terrain: TerrainProfile
  vegetation: VegetationFeature
  rng: Rng
}

/** Relative weight of each object in the overall score. */
const WEIGHTS: Record<ConfidenceKey, number> = {
  property: 1.4,
  building: 1.6,
  roof: 1.1,
  garage: 0.6,
  terrain: 0.8,
  vegetation: 0.7,
  interior: 1.0,
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Average confidence across a list, or a fallback when empty. */
function meanConfidence(items: { confidence: number }[], fallback: number): number {
  if (items.length === 0) return fallback
  return items.reduce((s, i) => s + i.confidence, 0) / items.length
}

export function computeConfidence(input: ConfidenceInput): ConfidenceReport {
  const { property, building, rng } = input
  void rng // no longer a source of confidence — kept for signature stability

  const garagePart = building.parts.find((p) => p.kind === 'garage' || p.kind === 'carport')

  /**
   * Everything except the parcel is still generated rather than observed, so it
   * all carries the `assumed` base. As real resolvers land (OSM in slice 2,
   * LoD2 in slice 3) these entries move up on their own — the aggregation does
   * not need to change, only the provenance the detectors report.
   */
  const provenance: Record<ConfidenceKey, Provenance> = {
    property: property.provenance.geometry,
    building: 'assumed',
    roof: 'assumed',
    garage: 'assumed',
    terrain: 'assumed',
    vegetation: 'assumed',
    interior: 'assumed',
  }

  const score = (key: ConfidenceKey): number =>
    key === 'property' ? round2(clamp01(property.confidence)) : round2(assumed(null).confidence)

  const byObject: Record<ConfidenceKey, number> = {
    property: score('property'),
    building: score('building'),
    roof: score('roof'),
    garage: garagePart ? score('garage') : 0,
    terrain: score('terrain'),
    vegetation: score('vegetation'),
    // The aerial cannot see inside at all, so the floor plan is the weakest
    // claim the pipeline makes — and the one the user should check first.
    interior: round2(assumed(null, 0.6).confidence),
  }

  const overall = aggregateConfidence(
    (Object.keys(byObject) as ConfidenceKey[])
      .filter((key) => !(key === 'garage' && !garagePart))
      .map((key) => ({ attr: { confidence: byObject[key] }, weight: WEIGHTS[key] })),
  )

  return { overall, byObject, provenance }
}

/** Format a 0..1 confidence as a whole-percent string (e.g. "92 %"). */
export function formatConfidence(v: number): string {
  return `${Math.round(clamp01(v) * 100)} %`
}

export const ConfidenceEngine = {
  id: 'confidence-engine',
  compute: computeConfidence,
  format: formatConfidence,
}
