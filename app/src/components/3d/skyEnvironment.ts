/**
 * skyEnvironment — der Himmel als Spiegelbild.
 *
 * Ein Fenster ist im Wesentlichen **kein** dunkles Rechteck. Es ist eine
 * Fläche, die den Himmel spiegelt, und genau daran erkennt das Auge Glas: an
 * dem hellen Streifen des Himmels darin, der sich mit dem Blickwinkel
 * verschiebt. Ohne diese Spiegelung bleibt jedes Fenster eine dunkle Platte,
 * egal welche Farbe sie hat — es ist die auffälligste Materialschwäche einer
 * erzeugten Fassade.
 *
 * Die Szene hat zwar eine Umgebungsspiegelung, aber es ist die **falsche**:
 * `scene.environment` trägt die eigens gebaute Archviz-Box für die Innenräume
 * (siehe `LocalEnvironment`). Ein Fenster im Haus gegenüber spiegelte damit ein
 * Fotostudio. Dazu kam ein physikalischer Fehler: die Glasmaterialien standen
 * auf `metalness` 0,25 bis 0,3. Glas ist ein Dielektrikum, sein Metallanteil
 * ist null — mit einem Metallanteil wird die Spiegelung eingefärbt und die
 * diffuse Farbe verschluckt, was die Scheiben zusätzlich abdunkelt.
 *
 * Beides zusammen erklärt die flachen dunklen Rechtecke vollständig.
 *
 * Diese Datei löst das, ohne die Innenbeleuchtung anzufassen: der Himmel wird
 * einmal zu einer Spiegelkarte aufbereitet und **je Material** als `envMap`
 * gesetzt. `scene.environment` bleibt die Innenraum-Box; ein Material mit
 * eigener `envMap` überschreibt sie nur für sich selbst. Innen bleibt innen,
 * draußen spiegelt der Himmel.
 *
 * Warum ein kleiner eigener Zustandsspeicher und kein Context: die Himmelskarte
 * entsteht in `SkyDome` tief im Canvas-Baum, gebraucht wird sie in
 * `Neighbourhood3D` daneben. Ein Context dazwischen müsste beide umschliessen
 * und würde bei jedem Sonnenstand den halben Baum neu auswerten.
 */

import { useEffect, useState } from 'react'
import type * as THREE from 'three'

let current: THREE.Texture | null = null
const listeners = new Set<(t: THREE.Texture | null) => void>()

/** Vom Himmel aufgerufen, sobald eine neue Spiegelkarte fertig ist. */
export function publishSkyEnvironment(tex: THREE.Texture | null): void {
  current = tex
  for (const fn of listeners) fn(tex)
}

/** Die aktuelle Himmelsspiegelung, oder `null`, solange keine vorliegt. */
export function useSkyEnvironment(): THREE.Texture | null {
  const [tex, setTex] = useState<THREE.Texture | null>(current)
  useEffect(() => {
    // Zwischen Anmeldung und erstem Ereignis kann bereits eine Karte
    // veröffentlicht worden sein — deshalb einmal nachziehen.
    setTex(current)
    listeners.add(setTex)
    return () => { listeners.delete(setTex) }
  }, [])
  return tex
}
