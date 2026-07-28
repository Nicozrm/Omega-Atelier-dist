/**
 * propertyDetector.ts — the first phase: what is the parcel?
 *
 * Two paths, in strict order of trust:
 *
 *   1. **The parcel the user drew.** If it is there, it wins outright. The
 *      person in front of the screen knows where their boundary runs; no data
 *      source and certainly no generator beats that. Area, frontage, depth and
 *      orientation are then *measurements* of that ring, and the outline keeps
 *      its real shape all the way into the editor.
 *   2. **The synthetic fallback.** Only when nothing was drawn: a deterministic
 *      lot from the parcel grid, so a bare tap still produces something
 *      coherent. It is flagged `assumed`, and the confidence follows from that
 *      — the run no longer claims to have measured what it invented.
 *
 * Until a road source can answer it, the street side stays an assumption on
 * both paths. That is a deliberate, labelled gap rather than an oversight:
 * guessing it silently is what made the old output feel authoritative when it
 * was not.
 */

import type {
  AnalysisContext,
  DetectorModule,
  PropertyFeature,
  SatelliteImage,
} from './types'
import { polygonAreaSqm } from './geo'
import { parcelAt } from './world'
import { assumed, fromUser, USER_POLYGON_SOURCE } from './provenance'

export function rect(x0: number, y0: number, x1: number, y1: number) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

export function detectProperty(image: SatelliteImage, ctx: AnalysisContext): PropertyFeature {
  const rng = ctx.rng.fork(0x50524f50) // 'PROP'

  // Neither path can observe this yet. Most German plots front south onto the
  // estate road, with the occasional corner lot — kept deterministic per seed.
  const streetSide = rng.next() < 0.82 ? 'south' : rng.pick(['east', 'west'] as const)

  if (ctx.parcel) {
    const { polygon, widthM, depthM, orientationDeg, areaSqm } = ctx.parcel
    return {
      polygon,
      areaSqm,
      widthM,
      depthM,
      orientationDeg,
      streetSide,
      confidence: fromUser(polygon, USER_POLYGON_SOURCE).confidence,
      provenance: { geometry: 'user', streetSide: 'assumed' },
    }
  }

  const parcel = parcelAt(image.center)
  const widthM = Math.round(parcel.widthM * 10) / 10
  const depthM = Math.round(parcel.depthM * 10) / 10
  const polygon = rect(0, 0, widthM, depthM)

  return {
    polygon,
    areaSqm: Math.round(polygonAreaSqm(polygon)),
    widthM,
    depthM,
    orientationDeg: Math.round(parcel.orientationDeg * 10) / 10,
    streetSide,
    // Nothing here was observed — the lot comes from a hash of the coordinate.
    confidence: assumed(polygon).confidence,
    provenance: { geometry: 'assumed', streetSide: 'assumed' },
  }
}

export const PropertyDetector: DetectorModule<SatelliteImage, PropertyFeature> = {
  id: 'property-detector',
  label: 'Grundstück',
  run: detectProperty,
}
