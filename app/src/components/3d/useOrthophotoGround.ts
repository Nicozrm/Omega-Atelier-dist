/**
 * useOrthophotoGround — der Boden der Szene wird zum echten Luftbild.
 *
 * Bis hierher war die Grundfläche eine Rasentextur: plausibel, aber nirgendwo.
 * Man erkennt sein Zuhause aber nicht am Haus allein, sondern an der Einfahrt,
 * dem Pflaster, der Hecke, dem Nachbargrundstück. Genau das liefert die
 * amtliche Befliegung mit 10 cm Auflösung (siehe `sources/dop`).
 *
 * Die Regel ist dieselbe wie überall in dieser Pipeline: **gemessen schlägt
 * angenommen, angenommen schlägt leer.** Ohne Ort, ohne Befliegung oder bei
 * einem Ausfall bleibt der erzeugte Boden stehen — kein Ladebildschirm, kein
 * Fehler, nur weniger Wirklichkeit.
 */

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { resolveOrthophoto, type Orthophoto } from '@/lib/composer/sources/dop'
import type { PlanGeo } from '@/types'

export interface OrthophotoGround {
  texture: THREE.Texture | null
  /** Für die Nennung im Bild — die Lizenz verlangt sie nicht, der Anstand schon. */
  attribution?: string
  photo?: Orthophoto
  loading: boolean
}

export interface UseOrthophotoGroundInput {
  geo?: PlanGeo
  /** Kantenlänge der Grundebene in Metern — Bild und Ebene müssen deckungsgleich sein. */
  groundSizeM: number
  /** Kantenlänge der Textur in Pixeln. Höher = schärfer und teurer. */
  pixels?: number
  enabled?: boolean
}

export function useOrthophotoGround(input: UseOrthophotoGroundInput): OrthophotoGround {
  const { geo, groundSizeM, pixels = 2048, enabled = true } = input
  const [state, setState] = useState<OrthophotoGround>({ texture: null, loading: false })
  const runRef = useRef(0)

  // Auf ganze Meter gerundet, damit ein Pixel Kameradrift nicht jedes Mal ein
  // neues 2048er Bild anfordert.
  const sizeKey = Math.round(groundSizeM)

  useEffect(() => {
    const run = ++runRef.current
    if (!enabled || !geo) {
      setState({ texture: null, loading: false })
      return
    }
    const ac = new AbortController()
    setState((s) => ({ ...s, loading: true }))

    void (async () => {
      const found = await resolveOrthophoto(
        { at: { lat: geo.lat, lng: geo.lng }, groundSizeM: sizeKey, pixels },
        ac.signal,
      )
      if (run !== runRef.current || ac.signal.aborted) return
      if (!found) {
        setState({ texture: null, loading: false })
        return
      }

      const tex = new THREE.Texture(found.image)
      // Farbraum: das Luftbild ist ein Foto, also sRGB. Ohne diese Zeile wäre
      // der Boden sichtbar zu hell und flau — three würde die Werte als linear
      // interpretieren und ein zweites Mal aufhellen.
      tex.colorSpace = THREE.SRGBColorSpace
      // Der Boden wird fast immer flach gesehen. Ohne anisotrope Filterung
      // verwischt genau dort, wo das Auge die Struktur sucht.
      tex.anisotropy = 16
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
      tex.needsUpdate = true

      // Nachvollziehbar machen, was auf dem Boden liegt. Ob eine Textur wirklich
      // ankommt, lässt sich einem gerenderten Bild sonst nicht ansehen — und
      // die Frage „ist das mein Grundstück oder eine Erfindung?" ist genau die,
      // die dieser Digital Twin beantworten soll.
      console.info(
        `%cOMEGA Boden%c ${found.photo.source.label} · ${found.photo.groundSizeM} m auf `
        + `${found.photo.pixels} px = ${found.photo.cmPerPixel} cm/px`,
        'font-weight:600;color:#C7A24E', 'color:inherit',
      )
      ;(window as unknown as Record<string, unknown>).__OMEGA_GROUND__ = {
        quelle: found.photo.source.id,
        lizenz: found.photo.source.licence,
        bodenkanteM: found.photo.groundSizeM,
        pixel: found.photo.pixels,
        cmProPixel: found.photo.cmPerPixel,
      }

      setState({
        texture: tex,
        attribution: found.photo.source.attribution,
        photo: found.photo,
        loading: false,
      })
    })()

    return () => { ac.abort() }
  }, [enabled, geo?.lat, geo?.lng, sizeKey, pixels])

  // Die Textur hält ein GPU-Bild fest; ohne Freigabe sammelt jeder Ortswechsel
  // ein weiteres an.
  const lastTex = useRef<THREE.Texture | null>(null)
  useEffect(() => {
    if (lastTex.current && lastTex.current !== state.texture) lastTex.current.dispose()
    lastTex.current = state.texture
  }, [state.texture])
  useEffect(() => () => { lastTex.current?.dispose() }, [])

  return state
}
