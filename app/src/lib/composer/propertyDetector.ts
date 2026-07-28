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
import { assumed, fromUser, measured, USER_POLYGON_SOURCE } from './provenance'
import { streetSideFromRoads } from './resolvers/osmResolver'

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

  // Fallback für die Straßenseite: die meisten deutschen Grundstücke fronten
  // nach Süden zur Erschließungsstraße, gelegentlich ein Eckgrundstück.
  const guessed = rng.next() < 0.82 ? 'south' : rng.pick(['east', 'west'] as const)

  if (ctx.parcel) {
    const { polygon, widthM, depthM, orientationDeg, areaSqm } = ctx.parcel
    // Mit erfassten Straßen ist die Straßenseite keine Münze mehr, sondern die
    // Kante, an der die nächste befahrbare Straße entlangläuft.
    const fromOsm = ctx.osm ? streetSideFromRoads(ctx.osm.roads, { widthM, depthM }) : undefined
    // Stammt die Fläche aus dem Kataster, ist sie vermessen — der Rahmen wurde
    // dann in `runAnalysis` bereits aus dem Flurstück aufgebaut.
    const cadastral = ctx.alkis?.own
    return {
      polygon,
      areaSqm,
      widthM,
      depthM,
      orientationDeg,
      streetSide: fromOsm?.side ?? guessed,
      confidence: cadastral
        ? measured(polygon, ctx.alkis!.source).confidence
        : fromUser(polygon, USER_POLYGON_SOURCE).confidence,
      provenance: {
        geometry: cadastral ? 'measured' : 'user',
        streetSide: fromOsm ? 'measured' : 'assumed',
      },
      ...(fromOsm?.road.name ?? cadastral?.street
        ? { streetName: fromOsm?.road.name ?? cadastral?.street }
        : {}),
      ...(cadastral ? { parcelLabel: cadastral.label } : {}),
    }
  }

  const parcel = parcelAt(image.center)
  const widthM = Math.round(parcel.widthM * 10) / 10
  const depthM = Math.round(parcel.depthM * 10) / 10
  const polygon = rect(0, 0, widthM, depthM)
  const fromOsm = ctx.osm ? streetSideFromRoads(ctx.osm.roads, { widthM, depthM }) : undefined

  return {
    polygon,
    areaSqm: Math.round(polygonAreaSqm(polygon)),
    widthM,
    depthM,
    orientationDeg: Math.round(parcel.orientationDeg * 10) / 10,
    streetSide: fromOsm?.side ?? guessed,
    // Nothing here was observed — the lot comes from a hash of the coordinate.
    confidence: assumed(polygon).confidence,
    provenance: {
      geometry: 'assumed',
      streetSide: fromOsm ? 'measured' : 'assumed',
    },
    ...(fromOsm?.road.name ? { streetName: fromOsm.road.name } : {}),
  }
}

export const PropertyDetector: DetectorModule<SatelliteImage, PropertyFeature> = {
  id: 'property-detector',
  label: 'Grundstück',
  run: detectProperty,
}
