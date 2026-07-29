/**
 * SkyDome — aus dem Hintergrund wird Atmosphäre.
 *
 * Der Himmel dieser Szene war bis hierher ein `linear-gradient` im CSS des
 * Canvas-Elements. Das erklärt den Eindruck „wirkt eher wie ein Hintergrund als
 * eine echte Atmosphäre" vollständig, denn genau das war er auch — ein Bild
 * *hinter* der Szene, nicht ein Teil von ihr. Drei Dinge folgen daraus, und
 * alle drei sieht man:
 *
 *  1. **Er bewegt sich nicht.** Ein Verlauf am Bildschirm klebt am Bildschirm.
 *     Neigt man die Kamera nach oben, müsste das tiefe Zenitblau kommen; neigt
 *     man sie zum Horizont, der helle Dunst. Stattdessen blieb der Verlauf, wo
 *     er war — und ein Himmel, der sich beim Umsehen nicht ändert, ist für das
 *     Auge kein Himmel, sondern eine Wand.
 *  2. **Die Sonne war nicht drin.** Es gibt ein Sonnenlicht in der Szene und
 *     einen Sonnenstand im Modell, aber am Himmel selbst stand nichts. Kein
 *     Ball, kein Hof, keine Aufhellung in seiner Richtung. Ein Nachmittagslicht
 *     ohne sichtbare Ursache liest sich als Studiobeleuchtung.
 *  3. **Der Verlauf war linear.** Ein echter Himmel ändert sich dicht über dem
 *     Horizont schnell und im oberen Drittel kaum — die Sichtlinie läuft dort
 *     durch ein Vielfaches an Luft. Ein gleichmässiger Verlauf von oben nach
 *     unten ist die eine Kurve, die mit Sicherheit falsch ist.
 *
 * Hier steht deshalb ein equirektangulärer Himmel als `scene.background`. Er
 * hängt an der Kamera wie der echte, trägt Sonnenscheibe, Sonnenhof und
 * Horizontdunst, und seine Kurve ist die eines Himmels und nicht die einer
 * Verlaufsfüllung.
 *
 * **Was er ausdrücklich nicht anfasst:** `scene.environment`. Die Innenräume
 * werden von einer eigens gebauten Archviz-Box beleuchtet (siehe
 * `LocalEnvironment`), und die durch einen Aussenhimmel zu ersetzen würde die
 * abgestimmte Innenbeleuchtung austauschen, um den Aussenraum zu verbessern.
 * Hintergrund und Beleuchtung sind hier zwei Fragen.
 */

import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { EnvironmentState } from '@/lib/environment'
import { publishSkyEnvironment } from './skyEnvironment'

/**
 * Auflösung der Himmelskarte.
 *
 * Ein Himmel ist fast überall glatt, 1024 × 512 sind dafür reichlich. Die
 * einzige hohe Frequenz ist die Sonnenscheibe, und die wird nicht Pixel für
 * Pixel gerechnet, sondern als Verlauf darübergezeichnet — dadurch bleibt sie
 * rund und weich, statt bei rund 0,35° je Pixel zu einem Treppchen zu werden.
 */
const W = 1024
const H = 512

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export interface SkyDomeProps {
  env: EnvironmentState
}

/**
 * Zeichnet die Himmelskarte.
 *
 * Die Zeilen sind Höhenwinkel, die Spalten Himmelsrichtungen — three liest die
 * Karte mit `equirectUv`, also `u = atan2(z, x) / 2π + 0.5` und
 * `v = asin(y) / π + 0.5`. Eine `CanvasTexture` wird mit `flipY` hochgeladen,
 * die **oberste Leinwandzeile ist damit der Zenit**.
 */
function paintSky(env: EnvironmentState): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(W, H)
  const d = img.data

  const [zr, zg, zb] = hexToRgb(env.sky.zenithColor)
  const [hr, hg, hb] = hexToRgb(env.sky.horizonColor)
  const cloud = env.weather.cloudiness

  /**
   * Die Kurve des Verlaufs.
   *
   * `y^0.42` statt `y`: bei 10° Höhe ist der Himmel schon zu rund 40 % auf
   * Zenitfarbe, bei 45° zu über 80 %. Genau so verhält sich die reale
   * Luftsäule — und genau diese Krümmung fehlt einem CSS-Verlauf.
   * Bei Bewölkung wird die Kurve flacher, weil eine geschlossene Wolkendecke
   * tatsächlich gleichmässig leuchtet.
   */
  const curve = 0.42 + cloud * 0.34

  for (let py = 0; py < H; py++) {
    // Leinwandzeile → v → Höhenwinkel. Oben ist Zenit.
    const v = 1 - py / (H - 1)
    const dy = Math.sin((v - 0.5) * Math.PI)
    const up = Math.max(0, dy)

    const t = Math.pow(up, curve)
    let r = hr + (zr - hr) * t
    let g = hg + (zg - hg) * t
    let b = hb + (zb - hb) * t

    // Horizontdunst: die letzten Grad über der Kante werden heller und
    // entsättigter. Das ist der Übergang, an dem eine Szene ihre Tiefe bekommt
    // — er schliesst den Nebel der Szene optisch an den Himmel an.
    const haze = Math.pow(1 - up, 9)
    const hz = 0.16 + cloud * 0.12
    r += (hr * 1.1 - r) * haze * hz
    g += (hg * 1.1 - g) * haze * hz
    b += (hb * 1.12 - b) * haze * hz

    // Unter dem Horizont: kein zweiter Himmel, sondern ein dunkler Bodenton.
    // Man sieht ihn nur, wenn die Kamera unter die Grundebene taucht — dort
    // wäre ein gespiegelter Himmel das verräterischste Zeichen einer Kulisse.
    if (dy < 0) {
      const k = Math.min(1, -dy * 3.2)
      r += (r * 0.34 - r) * k
      g += (g * 0.34 - g) * k
      b += (b * 0.36 - b) * k
    }

    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 4
      // Feines Rauschen gegen Streifenbildung. Ein glatter Verlauf über 512
      // Zeilen in 8 Bit zeigt sonst sichtbare Bänder, und die verraten eine
      // gezeichnete Fläche sofort.
      const n = ((px * 7 + py * 13) % 3) - 1
      d[i] = r + n * 0.6
      d[i + 1] = g + n * 0.6
      d[i + 2] = b + n * 0.6
      d[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  /* ── Sonne ──────────────────────────────────────────────────────────
   *
   * Scheibe und Hof, an der Stelle, an der auch das Sonnenlicht steht. Beide
   * werden additiv aufgetragen (`lighter`), weil Licht sich addiert und nicht
   * deckt — mit normalem Auftrag bekäme die Sonne einen sichtbaren Rand.
   */
  const s = env.sun.direction
  if (env.sun.aboveHorizon && s.y > -0.05) {
    const u = Math.atan2(s.z, s.x) / (Math.PI * 2) + 0.5
    const vv = Math.asin(Math.max(-1, Math.min(1, s.y))) / Math.PI + 0.5
    const sx = u * (W - 1)
    const sy = (1 - vv) * (H - 1)

    // Nahe am Zenit zieht die equirektanguläre Projektion in die Breite. Ohne
    // Ausgleich wäre die Mittagssonne ein Band statt eines Balls.
    const stretch = Math.min(6, 1 / Math.max(0.17, Math.cos(Math.asin(s.y))))

    // Tiefstehend wird die Sonne rot und der Hof gross — die Luftsäule ist
    // dann am längsten. Hoch stehend ist sie klein, weiss und hart.
    const low = 1 - Math.min(1, s.y / 0.5)
    const warm = `rgba(255, ${Math.round(238 - low * 78)}, ${Math.round(210 - low * 130)},`
    const clear = 1 - cloud * 0.85

    /*
     * Dreimal zeichnen: an der Stelle selbst und je einmal eine Bildbreite
     * links und rechts davon.
     *
     * Die Karte ist rundum geschlossen — Spalte 0 und Spalte W grenzen
     * aneinander, das ist dieselbe Himmelsrichtung. Der Sonnenhof reicht aber
     * über ein Drittel der Bildbreite, und eine Abendsonne steht rechnerisch
     * bei px ≈ 1023, also genau auf der Naht. Nur einmal gezeichnet würde ihr
     * halber Hof an der Leinwandkante abgeschnitten: am Himmel stünde dann
     * eine Sonne, die nach einer Seite hell strahlt und zur anderen an einer
     * senkrechten Kante endet. Die beiden Kopien kosten nichts und schliessen
     * die Naht.
     */
    for (const wrap of [-W, 0, W]) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.translate(sx + wrap, sy)
      ctx.scale(stretch, 1)

      // Weiter Hof — die allgemeine Aufhellung des halben Himmels.
      const wide = ctx.createRadialGradient(0, 0, 0, 0, 0, H * (0.42 + low * 0.3))
      wide.addColorStop(0, `${warm} ${0.3 * clear})`)
      wide.addColorStop(1, `${warm} 0)`)
      ctx.fillStyle = wide
      ctx.fillRect(-W, -H, W * 2, H * 2)

      // Enger Hof — der helle Ring dicht um die Scheibe.
      const near = ctx.createRadialGradient(0, 0, 0, 0, 0, H * 0.075)
      near.addColorStop(0, `${warm} ${0.85 * clear})`)
      near.addColorStop(1, `${warm} 0)`)
      ctx.fillStyle = near
      ctx.fillRect(-W, -H, W * 2, H * 2)

      // Die Scheibe selbst. Rund 0,53° am echten Himmel; hier bewusst etwas
      // grösser, weil sie sonst nach der Tonwertabbildung kaum noch zu sehen
      // ist.
      const disc = ctx.createRadialGradient(0, 0, 0, 0, 0, H * 0.016)
      disc.addColorStop(0, `rgba(255,255,248, ${0.98 * clear})`)
      disc.addColorStop(0.62, `${warm} ${0.9 * clear})`)
      disc.addColorStop(1, `${warm} 0)`)
      ctx.fillStyle = disc
      ctx.fillRect(-W, -H, W * 2, H * 2)
      ctx.restore()
    }
  }

  return cv
}

export function SkyDome({ env }: SkyDomeProps) {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)

  /**
   * Nur neu zeichnen, wenn sich am Himmel etwas ändert, das man sehen kann.
   *
   * Der Zeitregler läuft stufenlos, ein Neuzeichnen sind eine halbe Million
   * Pixel. Der Sonnenstand wird deshalb auf rund zwei Grad gerundet und die
   * Bewölkung auf Zwanzigstel: der Himmel bleibt flüssig, die Karte entsteht
   * aber nur, wenn der Unterschied sichtbar wäre.
   */
  const key = useMemo(() => [
    env.sky.zenithColor, env.sky.horizonColor,
    Math.round(env.sun.direction.x * 32), Math.round(env.sun.direction.y * 32),
    Math.round(env.sun.direction.z * 32), env.sun.aboveHorizon,
    Math.round(env.weather.cloudiness * 20),
  ].join('|'), [env])

  useEffect(() => {
    const tex = new THREE.CanvasTexture(paintSky(env))
    tex.mapping = THREE.EquirectangularReflectionMapping
    tex.colorSpace = THREE.SRGBColorSpace
    // Der Verlauf ist glatt; ohne lineare Filterung an der Naht bei u = 0
    // entsteht eine sichtbare senkrechte Kante.
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.RepeatWrapping
    tex.needsUpdate = true

    const previous = scene.background
    scene.background = tex

    /*
     * Derselbe Himmel noch einmal, als Spiegelkarte.
     *
     * Eine Spiegelung braucht die Karte in vorgefilterter Form — je rauer ein
     * Material, desto unschärfer muss sein Spiegelbild sein, und das lässt sich
     * nicht zur Laufzeit je Pixel rechnen. `PMREMGenerator` erzeugt genau diese
     * Stufenleiter einmal.
     *
     * Sie wird bewusst **nicht** an `scene.environment` gehängt: dort sitzt die
     * Innenraum-Box, die die Räume beleuchtet. Stattdessen bekommt jedes
     * Aussenmaterial sie einzeln als `envMap` — siehe `skyEnvironment`.
     */
    let env3d: THREE.WebGLRenderTarget | null = null
    try {
      const pmrem = new THREE.PMREMGenerator(gl)
      env3d = pmrem.fromEquirectangular(tex)
      pmrem.dispose()
      publishSkyEnvironment(env3d.texture)
    } catch {
      // Ohne Spiegelkarte bleibt der Himmel trotzdem stehen; die Fenster
      // spiegeln dann nur nichts. Ein Himmel ohne Spiegelung ist besser als
      // gar keiner.
      publishSkyEnvironment(null)
    }

    return () => {
      // Nur zurücknehmen, was noch uns gehört — sonst überschreibt der Abbau
      // eines alten Himmels den neuen, der schon hängt.
      if (scene.background === tex) scene.background = previous
      tex.dispose()
      if (env3d) {
        publishSkyEnvironment(null)
        env3d.dispose()
      }
    }
    // `key` ist die Absicht, `env` nur die Quelle der Werte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, gl, key])

  return null
}
