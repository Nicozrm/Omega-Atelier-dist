/**
 * useNeighbourhood — welche Welt die 3D-Ansicht zeigt.
 *
 * Die Regel ist einfach und folgt dem Architekturentwurf: **gemessen schlägt
 * angenommen, aber angenommen schlägt leer.**
 *
 *   • Der Plan kennt keinen Ort → der prozedurale Generator liefert eine
 *     plausible Siedlung. Genau wie bisher.
 *   • Der Plan kennt seinen Ort → OSM wird abgerufen und die **echte**
 *     Nachbarschaft gebaut. Bis die Antwort da ist, steht die erzeugte Welt;
 *     der Wechsel ist ein einzelnes Re-Render, kein Ladebildschirm.
 *   • Der Abruf scheitert oder der Ort ist nicht erfasst → die erzeugte Welt
 *     bleibt stehen.
 *
 * Der Nutzer sieht also nie eine leere Fläche, und die Ansicht weiß jederzeit,
 * was sie zeigt (`source`), damit die Oberfläche es benennen kann.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  generateNeighbourhood, neighbourhoodFromOsm, seedForPlan,
  type CityStyle, type Neighbourhood, type WorldDetail,
} from '@/lib/world'
import { worldOsmSource } from '@/lib/composer/sources/overpass'
import { extractBuildings, extractPois, extractRoads, pickOwnBuilding } from '@/lib/composer/resolvers/osmResolver'
import { plainFrame } from '@/lib/composer/frame'
import type { PlanGeo } from '@/types'

export type WorldSource = 'generated' | 'osm'

export interface NeighbourhoodResult {
  world: Neighbourhood
  source: WorldSource
  /** Läuft gerade ein Abruf? Für einen dezenten Hinweis in der Oberfläche. */
  loading: boolean
}

export interface UseNeighbourhoodInput {
  planId: string
  geo?: PlanGeo
  style: CityStyle
  detail: WorldDetail
  /** Mittelpunkt des Plans in Weltmetern. */
  centre: { x: number; z: number }
  widthM: number
  depthM: number
  /** Abschaltbar, damit die Ansicht auch offline berechenbar bleibt. */
  enabled?: boolean
}

export function useNeighbourhood(input: UseNeighbourhoodInput): NeighbourhoodResult {
  const { planId, geo, style, detail, centre, widthM, depthM, enabled = true } = input

  // Die erzeugte Welt ist immer da — sie kostet nichts und ist der Rückfall.
  const generated = useMemo(
    () => generateNeighbourhood({
      style, centre, widthM, depthM, detail, seed: seedForPlan(planId, style),
    }),
    [style, centre.x, centre.z, widthM, depthM, detail, planId],
  )

  const [osmWorld, setOsmWorld] = useState<Neighbourhood | null>(null)
  const [loading, setLoading] = useState(false)
  // Verhindert, dass eine spät eintreffende Antwort eine neuere überschreibt.
  const runRef = useRef(0)

  useEffect(() => {
    setOsmWorld(null)
    if (!enabled || !geo) return
    const run = ++runRef.current
    const ac = new AbortController()
    setLoading(true)

    void (async () => {
      try {
        const at = { lat: geo.lat, lng: geo.lng }
        const result = await worldOsmSource.fetchSite(at, ac.signal)
        if (run !== runRef.current || !result) return

        // Der Rahmen ist hier bewusst nordausgerichtet und im Plan-Mittelpunkt
        // verankert: die 3D-Szene rechnet in Weltmetern um den Plan herum, und
        // die Drehung des Grundstücks steckt bereits im Plan selbst.
        const frame = plainFrame(at)
        const reference = { x: 0, y: 0 }
        const buildings = extractBuildings(result, frame, undefined)
        const roads = extractRoads(result, frame, reference)
        const pois = extractPois(result, frame, reference)
        if (buildings.length === 0 && roads.length === 0) return

        // Die Quelle liefert Meter relativ zum Anker; die Szene erwartet sie
        // relativ zum Plan-Mittelpunkt.
        const shift = (p: { x: number; y: number }) => ({ x: p.x + centre.x, y: p.y + centre.z })
        const shifted = buildings.map((b) => ({
          ...b,
          footprint: b.footprint.map(shift),
          centre: shift(b.centre),
        }))
        const shiftedRoads = roads.map((r) => ({ ...r, path: r.path.map(shift) }))
        const shiftedPois = pois.map((p) => ({ ...p, at: shift(p.at) }))

        const world = neighbourhoodFromOsm({
          style, detail,
          centre,
          buildings: shifted,
          roads: shiftedRoads,
          pois: shiftedPois,
          ownId: pickOwnBuilding(buildings)?.osmId,
          seed: seedForPlan(planId, style),
        })
        // Ohne Straßen und ohne Häuser wäre die echte Welt ärmer als die
        // erzeugte — dann lieber bei der Annahme bleiben.
        if (world.houses.length === 0 && world.network.segments.length === 0) return
        if (run === runRef.current) setOsmWorld(world)
      } catch {
        /* Ausfall ist vorgesehen — die erzeugte Welt bleibt stehen. */
      } finally {
        if (run === runRef.current) setLoading(false)
      }
    })()

    return () => { ac.abort() }
  }, [enabled, geo?.lat, geo?.lng, style, detail, centre.x, centre.z, planId])

  return {
    world: osmWorld ?? generated,
    source: osmWorld ? 'osm' : 'generated',
    loading,
  }
}
