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
 * Hier steht deshalb eine echte Himmelskuppel **in** der Szene. Sie hängt an
 * der Kamera wie der echte Himmel, trägt Sonnenscheibe, Sonnenhof und
 * Horizontdunst, und ihre Kurve ist die eines Himmels und nicht die einer
 * Verlaufsfüllung.
 *
 * Ein vierter Punkt kam erst beim Nachsehen dazu, und er war der schlimmste:
 * der Canvas ist mit `alpha: false` angelegt. Der CSS-Verlauf hinter dem
 * Element konnte also **nie** zu sehen sein — ohne gesetzten Szenenhintergrund
 * war die Löschfarbe schwarz. Der Taghimmel dieser Anwendung war schlicht ein
 * schwarzes Loch, und der Kommentar am nächtlichen Stadthintergrund sagt es
 * sogar („where a black void reads worst"), ohne dass jemand den Schluss
 * gezogen hätte.
 *
 * **Was er ausdrücklich nicht anfasst:** `scene.environment`. Die Innenräume
 * werden von einer eigens gebauten Archviz-Box beleuchtet (siehe
 * `LocalEnvironment`), und die durch einen Aussenhimmel zu ersetzen würde die
 * abgestimmte Innenbeleuchtung austauschen, um den Aussenraum zu verbessern.
 * Hintergrund und Beleuchtung sind hier zwei Fragen.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { EnvironmentState } from '@/lib/environment'
import { publishSkyEnvironment } from './skyEnvironment'
import { hexToRgb, skyIrradiance, skyRadiance, type SkyModel } from '@/lib/skyModel'

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

export interface SkyDomeProps {
  env: EnvironmentState
  /**
   * Albedo des Bodens, 0…1 je Kanal — was die Fläche unter der Szene an Licht
   * zurückwirft. Rasen wirft grünlich und rund ein Viertel, Asphalt neutral und
   * gut ein Achtel.
   */
  groundAlbedo?: [number, number, number]
}

/** Rasen als Vorgabe: der häufigste Untergrund einer Wohnsiedlung. */
const DEFAULT_GROUND_ALBEDO: [number, number, number] = [0.19, 0.25, 0.14]

/**
 * Zeichnet die Himmelskarte.
 *
 * Die Zeilen sind Höhenwinkel, die Spalten Himmelsrichtungen — three liest die
 * Karte mit `equirectUv`, also `u = atan2(z, x) / 2π + 0.5` und
 * `v = asin(y) / π + 0.5`. Eine `CanvasTexture` wird mit `flipY` hochgeladen,
 * die **oberste Leinwandzeile ist damit der Zenit**.
 */
function paintSky(env: EnvironmentState, groundAlbedo: [number, number, number]): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(W, H)
  const d = img.data
  const cloud = env.weather.cloudiness

  /*
   * Der Himmel wird nicht mehr hier beschrieben, sondern in `lib/skyModel`.
   *
   * Das ist kein Aufräumen: die Karte ist ab jetzt **auch die Lichtquelle** des
   * Aussenraums, und was eine Szene beleuchtet, muss nachrechenbar sein. Läge
   * die Formel im Zeichner, liesse sich die Beleuchtungsstärke nur messen,
   * indem man das Bild wieder ausliest — und jede spätere Änderung am Verlauf
   * würde die Helligkeit der ganzen Szene verschieben, ohne dass es auffällt.
   */
  const sky: SkyModel = {
    zenith: hexToRgb(env.sky.zenithColor),
    horizon: hexToRgb(env.sky.horizonColor),
    cloudiness: cloud,
    groundAlbedo,
  }
  // Einmal vorab: der Bodenanteil ist das vom Himmel beleuchtete Rückwurflicht
  // und braucht deshalb die Beleuchtungsstärke der oberen Halbkugel.
  const upper = skyIrradiance(sky)

  for (let py = 0; py < H; py++) {
    // Leinwandzeile → v → Höhenwinkel. Oben ist Zenit.
    const v = 1 - py / (H - 1)
    const dy = Math.sin((v - 0.5) * Math.PI)
    const [r, g, b] = skyRadiance(sky, dy, upper)

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

export function SkyDome({ env, groundAlbedo = DEFAULT_GROUND_ALBEDO }: SkyDomeProps) {
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
    groundAlbedo.map((c) => Math.round(c * 40)).join(','),
  ].join('|'), [env, groundAlbedo])

  /*
   * Der Himmel wird als **Kuppel gezeichnet**, nicht als `scene.background`
   * gesetzt.
   *
   * Der Weg über `scene.background` war der naheliegende und hat sich als
   * unbrauchbar erwiesen: three wandelt eine equirektanguläre Hintergrundtextur
   * intern erst in eine Cubemap um (`WebGLCubeMaps.get` →
   * `fromEquirectangularTexture`), und auf dem Gerät des Nutzers kam dabei
   * nichts an — der Himmel blieb schwarz, obwohl die Karte nachweislich
   * korrekte Farben enthält (der Nebel, der dieselbe Horizontfarbe benutzt,
   * war richtig). Ich kann diese Umwandlung hier nicht nachstellen, also
   * ersetze ich sie durch einen Weg ohne sie.
   *
   * Die Kuppel bringt zwei Dinge mit, die der Hintergrund nicht hatte:
   *
   *  • **Sie wird tonwertabgebildet.** three setzt bei einer sRGB-Hintergrund-
   *    textur `toneMapped = false`; der Himmel lief also an AgX vorbei,
   *    während die gesamte Geometrie hindurchgeht. Ein Himmel, der anders
   *    belichtet ist als die Häuser davor, sitzt nicht im Bild — genau der
   *    Eindruck „wirkt wie ein Hintergrund", den er nicht mehr machen soll.
   *  • **Sie ist nachvollziehbar.** Ein `MeshBasicMaterial` auf einer Kugel
   *    hat keine verborgene Umwandlung.
   *
   * Zur Spiegelung der Textur: die Kugel wird von **innen** gesehen
   * (`BackSide`), und ihre UV-Achse läuft der equirektangulären entgegen.
   * Durchgerechnet an vier Stellen — Kugel-u 0 → 0, 0,25 → 0,75, 0,5 → 0,5,
   * 0,75 → 0,25 — also `u_karte = 1 − u_kugel`. Genau das leisten
   * `repeat.x = −1` und `offset.x = 1`. Ohne diese Zeile stünde die Sonne
   * spiegelverkehrt am Himmel, während die Schatten weiter aus der richtigen
   * Richtung kämen. Geprüft in `verify:sky`.
   */
  const [tex, setTex] = useState<THREE.Texture | null>(null)
  const domeRef = useRef<THREE.Mesh>(null)

  useEffect(() => {
    const canvas = paintSky(env, groundAlbedo)

    // Fassung für die Kuppel — waagerecht gespiegelt (siehe oben).
    const dome = new THREE.CanvasTexture(canvas)
    dome.colorSpace = THREE.SRGBColorSpace
    dome.minFilter = THREE.LinearFilter
    dome.magFilter = THREE.LinearFilter
    dome.wrapS = THREE.RepeatWrapping
    dome.repeat.x = -1
    dome.offset.x = 1
    dome.needsUpdate = true
    setTex(dome)

    /*
     * Dieselbe Karte noch einmal, als Spiegelkarte für die Materialien.
     *
     * Eine Spiegelung braucht die Karte in vorgefilterter Form — je rauer ein
     * Material, desto unschärfer sein Spiegelbild, und das lässt sich nicht
     * zur Laufzeit je Pixel rechnen. `PMREMGenerator` erzeugt diese
     * Stufenleiter einmal. Hier ist die Ausrichtung ungespiegelt, weil die
     * Umgebungskarte in Weltkoordinaten gelesen wird und nicht über UV.
     *
     * Sie wird bewusst **nicht** an `scene.environment` gehängt: dort sitzt
     * die Archviz-Box, die die Innenräume beleuchtet.
     */
    const src = new THREE.CanvasTexture(canvas)
    src.mapping = THREE.EquirectangularReflectionMapping
    src.colorSpace = THREE.SRGBColorSpace
    src.needsUpdate = true

    let env3d: THREE.WebGLRenderTarget | null = null
    try {
      const pmrem = new THREE.PMREMGenerator(gl)
      env3d = pmrem.fromEquirectangular(src)
      pmrem.dispose()
      publishSkyEnvironment(env3d.texture)
    } catch {
      // Ohne Spiegelkarte bleibt der Himmel trotzdem stehen; die Fenster
      // spiegeln dann nur nichts.
      publishSkyEnvironment(null)
    }
    src.dispose()

    /*
     * Rückfall: eine schlichte Farbe als Hintergrund.
     *
     * Der Canvas ist mit `alpha: false` angelegt, also undurchsichtig — ohne
     * gesetzten Hintergrund ist die Löschfarbe **schwarz**, und der
     * CSS-Verlauf hinter dem Element kann grundsätzlich nicht durchscheinen.
     * Genau daher kam der schwarze Taghimmel. Eine Farbe geht in three den
     * `isColor`-Weg ohne jede Umwandlung; sollte die Kuppel je ausfallen,
     * steht dort dann der Horizontton statt eines Lochs.
     */
    const previous = scene.background
    scene.background = new THREE.Color(env.sky.horizonColor)

    return () => {
      scene.background = previous
      setTex(null)
      dome.dispose()
      if (env3d) {
        publishSkyEnvironment(null)
        env3d.dispose()
      }
    }
    // `key` ist die Absicht, `env` nur die Quelle der Werte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, gl, key])

  // Die Kuppel bleibt um die Kamera zentriert — sonst fährt man aus ihr heraus.
  useFrame(({ camera }) => {
    if (domeRef.current) domeRef.current.position.copy(camera.position)
  })

  if (!tex) return null
  return (
    <mesh ref={domeRef} renderOrder={-1000} frustumCulled={false} scale={900}>
      <sphereGeometry args={[1, 48, 32]} />
      <meshBasicMaterial
        map={tex}
        side={THREE.BackSide}
        // Ohne Tiefentest und ohne Tiefenschreiben zeichnet die Kuppel als
        // Erstes und alles andere darüber — unabhängig von ihrer Grösse.
        depthTest={false}
        depthWrite={false}
        fog={false}
      />
    </mesh>
  )
}
