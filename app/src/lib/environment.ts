import { kelvinToHex } from '@/lib/lighting'
import { solarPosition, dayOfYear } from '@/lib/solar'

/**
 * environment.ts — the renderer-neutral **environment domain**.
 *
 * This is the single source of truth for the *physical state of the world around
 * the model*: time, the sun's position, the sky, and the weather — and, derived
 * from that physical state, the renderable lighting. Output is plain data (hex
 * colours, scalars, a unit vector); there are no THREE types and no rendering
 * concerns, and every colour-from-temperature step is delegated to `lighting.ts`
 * (`kelvinToHex`) so Kelvin maths lives in exactly one place.
 *
 * Design intent (Digital-Twin platform): this domain is deliberately *more
 * general than any one renderer*. `deriveEnvironment` is the only entry point —
 * renderers (and, later, solar-yield, shading, window-light and energy analyses)
 * consume the returned `EnvironmentState`, never internal helpers. The physical
 * fields (`sun`, `weather`, `time`) exist so those future features read the same
 * world state the 3D view does, and so weather, seasons, window light and
 * atmospheric parameters slot in here without touching a renderer.
 */

export type Weather = 'clear' | 'cloudy' | 'overcast'
export type DayPhase = 'night' | 'dawn' | 'goldenHour' | 'day' | 'dusk'

export interface EnvironmentInput {
  /** Hour of day, 0…24. The primary driver. Default: noon (12). */
  timeOfDay?: number
  /** Calendar date for seasonal sun. Default: spring equinox. */
  date?: { month: number; day: number }
  /** Observer latitude, degrees (+N / −S). Default: central-European latitude. */
  latitudeDeg?: number
  /** Building orientation, degrees (plan vs true compass). Default: 0. */
  orientationDeg?: number
  /** Sky / weather condition. Default: 'clear'. */
  weather?: Weather
}

/** Physical sun — reusable for solar yield, shading and window light. */
export interface SunState {
  azimuth: number
  elevation: number
  aboveHorizon: boolean
  /** Unit vector toward the sun, +X=east, +Y=up, +Z=south (plan-aligned). */
  direction: { x: number; y: number; z: number }
}

export interface SkyState {
  zenithColor: string
  horizonColor: string
  /** Overall sky luminance, 0…1 (background brightness, IBL strength, …). */
  intensity: number
}

export interface WeatherState {
  condition: Weather
  /** 0 (clear) … 1 (fully overcast). */
  cloudiness: number
}

/** Renderable lighting derived from the physical state. */
export interface RenderLighting {
  ambient: { color: string; intensity: number }
  hemisphere: { skyColor: string; groundColor: string; intensity: number }
  sun: {
    color: string
    intensity: number
    castShadow: boolean
    /** Shadow strength, normalised for direct use as a shadow opacity (0…~0.55). */
    shadowIntensity: number
  }
  /**
   * Exterior-albedo multiplier, 0.07 (deep night) … 1 (full day). The world
   * *around* the model has no interior fixtures, so its surfaces recede with
   * daylight. A single **continuous** scalar (see `exteriorLightScale`) drives
   * every exterior surface — neighbourhood, own-house shell, distant backdrop —
   * so scrubbing time never steps the surroundings between brightness buckets.
   */
  exteriorAlbedoScale: number
  /**
   * Belichtung — die Blende der Kamera, 1 … 1,75.
   *
   * Sobald die Sonne das Tageslicht trägt statt eines richtungslosen
   * Fülllichts, folgt die Bildhelligkeit dem Sonnenstand: nachmittags um 16 Uhr
   * steht die Sonne 17° hoch und liefert auf eine waagerechte Fläche nur noch
   * ein Drittel der Mittagseinstrahlung. Physikalisch ist das genau richtig —
   * fotografisch ist es unbrauchbar, weil hier jemand an einem Regler zieht und
   * das Bild nicht bei jeder Uhrzeit um ein Drittel einbrechen darf.
   *
   * Eine Kamera löst das mit der Blende, nicht mit stärkerem Licht: sie hebt
   * den Pegel und lässt das **Verhältnis** zwischen Licht und Schatten
   * unangetastet. Genau das tut dieser Faktor. Er ersetzt kein Fülllicht — er
   * belichtet nach.
   *
   * Nachts bleibt er bewusst auf exakt 1: die Nacht ist getrimmt, und eine
   * automatische Aufhellung würde sie zum Abend machen.
   */
  exposure: number
}

export interface EnvironmentState {
  time: { hour: number; dayOfYear: number }
  sun: SunState
  phase: DayPhase
  weather: WeatherState
  sky: SkyState
  lighting: RenderLighting
}

// ─── Defaults ────────────────────────────────────────────────
const DEFAULT_LATITUDE = 52 // ~ central Europe
const DEFAULT_DATE = { month: 3, day: 20 } // spring equinox (balanced day length)

// ─── Small colour helpers (kept local; Kelvin stays in lighting.ts) ───
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const k = Math.max(0, Math.min(1, t))
  return rgbToHex(ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k)
}
/** Pull a colour toward its grey luminance (weather desaturation). */
function desaturate(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex)
  const grey = 0.299 * r + 0.587 * g + 0.114 * b
  const k = Math.max(0, Math.min(1, t))
  return rgbToHex(r + (grey - r) * k, g + (grey - g) * k, b + (grey - b) * k)
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

// Sky anchor colours, blended by daylight factor + weather.
const SKY_DAY_ZENITH = '#6f9fd0'
const SKY_DAY_HORIZON = '#cfe0ec'
// Near-neutral night sky — the archviz reference floats the lit model on a
// near-black backdrop; a strong blue cast reads as "video game night".
/*
 * Nachthimmel.
 *
 * Vorher `#080a11` und `#131722` — also RGB 8/10/17 und 19/23/34. Solange der
 * Himmel nur ein CSS-Verlauf hinter einem undurchsichtigen Canvas war, hat das
 * niemanden gestört, weil er ohnehin nicht zu sehen war. Seit er als Kuppel in
 * der Szene steht, ist er das Erste, was man nachts sieht — und bei diesen
 * Werten ist er auf jedem Bildschirm schlicht Schwarz. Damit fehlt die
 * Horizontlinie, und ohne Horizont hat eine Nachtszene keine Tiefe: die
 * Dächer stehen vor nichts.
 *
 * Ein realer Nachthimmel ist nie schwarz. Selbst ohne Mond hebt ihn das
 * Streulicht der Umgebung deutlich über Null, und über einem Wohngebiet kommt
 * die Aufhellung der Ortschaft dazu. Die neuen Werte bleiben tief — es ist
 * unmissverständlich Nacht —, geben dem Auge aber eine Kante zum Anhalten und
 * den Fenstern etwas zu spiegeln.
 */
const SKY_NIGHT_ZENITH = '#121a2e'
const SKY_NIGHT_HORIZON = '#26314a'
const SKY_GOLDEN_HORIZON = '#e8a25c'

function cloudinessFor(w: Weather): number {
  switch (w) {
    case 'overcast':
      return 0.9
    case 'cloudy':
      return 0.45
    default:
      return 0.0
  }
}

/** Sun colour temperature from elevation: warm near the horizon, cool high. */
function sunKelvin(elevationDeg: number): number {
  const t = clamp01(elevationDeg / 60)
  return Math.round(2100 + t * (5800 - 2100))
}

function phaseFor(elevationDeg: number, hour: number): DayPhase {
  if (elevationDeg <= -3) return 'night'
  if (elevationDeg <= 0) return hour < 12 ? 'dawn' : 'dusk'
  if (elevationDeg <= 10) return 'goldenHour'
  return 'day'
}

/**
 * Continuous exterior-albedo scale from the sun's elevation, 0.07 … 1.
 *
 * The surroundings carry no interior lighting, so at night they must recede
 * toward black — but as a **smooth** function of the sun, never a step. Earlier
 * this was a five-value lookup keyed on the day phase, so scrubbing the clock
 * popped the whole neighbourhood between brightness levels at each phase border
 * (≈0.36 in one frame).
 *
 * The tuned brightness *plateaus* are preserved exactly — deep night 0.07,
 * golden hour 0.62, full day 1.0 — so a settled time of day looks identical to
 * before. Only the three narrow bands *between* plateaus are smoothed
 * (smoothstep, C¹), turning each former pop into a seamless dissolve. Der
 * Nachtboden hält die Siedlung im Dunkeln lesbar, statt sie auf Schwarz zu
 * quetschen — siehe die Begründung am Wert selbst.
 */
export function exteriorLightScale(elevationDeg: number): number {
  const smooth = (e0: number, e1: number, x: number) => {
    const t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)
  }
  /*
   * Der Nachtwert war 0,07 — die Albedo jeder Aussenfläche also auf sieben
   * Prozent gestaucht. Eine weisse Wand (Albedo 0,8) landet damit bei 0,056 und
   * wird, mit dem ohnehin gedämpften Umgebungslicht multipliziert, ununter-
   * scheidbar von Schwarz. Der Kommentar oben behauptet, 0,07 halte die
   * Siedlung „legible in the dark"; im Bild tut er das nicht.
   *
   * Der eigentliche Grund für das Einbrechen ist, dass hier **die Albedo**
   * gedimmt wird und nicht das Licht. Eine Kamera öffnet nachts die Blende;
   * diese Szene rechnet stattdessen die Oberflächen dunkel, und das lässt sich
   * durch keine Belichtung mehr zurückholen. 0,18 ist der Kompromiss, der die
   * Silhouetten wieder zeigt, ohne die Nacht zum Abend zu machen — die
   * Verhältnisse zwischen Tag und Nacht bleiben mit gut 1 : 5 deutlich.
   */
  const NIGHT = 0.18, TWILIGHT = 0.32, GOLDEN = 0.62, DAY = 1.0
  return (
    NIGHT +
    (TWILIGHT - NIGHT) * smooth(-6, 0, elevationDeg) + // night → twilight
    (GOLDEN - TWILIGHT) * smooth(-3, 3, elevationDeg) + // twilight → golden hour
    (DAY - GOLDEN) * smooth(6, 14, elevationDeg) //       golden hour → full day
  )
}

/**
 * Resolve the complete environment state for the given world conditions.
 * The single entry point for the environment domain.
 */
export function deriveEnvironment(input: EnvironmentInput = {}): EnvironmentState {
  const hour = input.timeOfDay ?? 12
  const date = input.date ?? DEFAULT_DATE
  const doy = dayOfYear(date.month, date.day)
  const latitudeDeg = input.latitudeDeg ?? DEFAULT_LATITUDE
  const orientationDeg = input.orientationDeg ?? 0
  const condition = input.weather ?? 'clear'
  const cloudiness = cloudinessFor(condition)

  const pos = solarPosition({ hour, dayOfYear: doy, latitudeDeg, orientationDeg })
  const elevation = pos.elevation

  // Daylight factor: 0 below the horizon (incl. civil twilight) … 1 at zenith.
  const daylightF = clamp01((elevation + 6) / 60)
  const phase = phaseFor(elevation, hour)

  // ── Sky ──
  const zenithBase = mix(SKY_NIGHT_ZENITH, SKY_DAY_ZENITH, daylightF)
  let horizonBase = mix(SKY_NIGHT_HORIZON, SKY_DAY_HORIZON, daylightF)
  // Warm the horizon while the sun is low (golden hour / twilight).
  if (elevation > -4 && elevation <= 12) {
    const golden = clamp01(1 - Math.abs(elevation - 3) / 9)
    horizonBase = mix(horizonBase, SKY_GOLDEN_HORIZON, golden * 0.7)
  }
  const sky: SkyState = {
    zenithColor: desaturate(zenithBase, cloudiness * 0.7),
    horizonColor: desaturate(horizonBase, cloudiness * 0.7),
    intensity: clamp01(0.1 + daylightF * 0.9) * (1 - cloudiness * 0.25),
  }

  // ── Sun (render light) ──
  const above = pos.aboveHorizon
  const sunStrength = clamp01(Math.sin(Math.max(0, elevation) * (Math.PI / 180)))
  // Perceptual drive: sin(elevation) alone leaves the golden-hour sun nearly
  // invisible (5° → 0.09). The sub-linear curve lifts the low sun into the
  // warm, long-shadow drama archviz golden hour is known for, while noon
  // changes only marginally (0.87 → 0.92).
  const sunDrive = Math.pow(sunStrength, 0.6)
  const sunColor = kelvinToHex(above ? sunKelvin(elevation) : 6500)
  /*
   * Das Verhältnis von Sonne zu Fülllicht — der eigentliche Hebel des Bildes.
   * ────────────────────────────────────────────────────────────────────────
   * Hier stand `sunDrive * 1.4`, während Ambient (0,24), Hemisphere (0,65) und
   * die Studio-IBL (Faktor 1,0 auf Paneele mit 2,4- bis 3,0-facher Helligkeit)
   * gleichzeitig Fülllicht aus allen Richtungen einspeisten. Nachgemessen
   * am fertigen Bild: das Verhältnis Sonne zu Fülllicht lag bei etwa 1 : 2.
   *
   * Ein Bild ohne Lichtverhältnis hat keine Lichtrichtung, und ohne
   * Lichtrichtung gibt es keinen sichtbaren Schattenwurf — der Rasen im
   * Standbild schwankte über seine ganze Fläche um weniger als 15 von 255
   * Helligkeitsstufen, war also vollkommen flach. Kein Kantenglätter, kein
   * Umgebungsverdecker und keine Tonwertkurve holt das zurück; sie alle
   * arbeiten auf einem Bild, das seine Form bereits verloren hat.
   *
   * Drei Dinge waren zusammengekommen:
   *
   *  1. three.js rechnet seit r155 physikalisch: der diffuse Anteil wird durch
   *     π geteilt. Eine gerichtete Lichtquelle mit Stärke 1 liefert damit rund
   *     0,32 — Tageslicht ist das nicht, und zwar um etwa den Faktor vier.
   *  2. Ambient ist das flachste Licht überhaupt. Es trifft jede Fläche gleich,
   *     füllt also **gezielt** genau die Stellen auf, die den Schatten
   *     ausmachen: Ecken, Kontaktkanten, abgewandte Seiten.
   *  3. Die Studio-IBL ist eine Innenraum-Lichtbox. Sie gehört an ein
   *     Möbelfoto, nicht über eine Siedlung bei Mittagssonne.
   *
   * Deshalb ab hier: die Sonne trägt das Tageslicht (Faktor ~5), Ambient wird
   * fast abgeschaltet und das Himmelslicht der Hemisphere bleibt das einzige
   * nennenswerte Fülllicht — es ist wenigstens gerichtet (oben hell, unten
   * dunkel) und modelliert dadurch, statt zu planieren.
   *
   * Bewölkung dreht das Verhältnis bewusst um: dann *ist* der Himmel die
   * Lichtquelle, die Sonne verschwindet und das Fülllicht steigt. Genau so
   * sieht ein bedeckter Tag aus — schattenlos und weich.
   */
  const sunIntensity = above ? sunDrive * 5.2 * (1 - 0.82 * cloudiness) : 0
  const shadowIntensity = above ? sunDrive * (1 - 0.85 * cloudiness) * 0.55 : 0

  // ── Ambient + hemisphere ──
  /*
   * Beide Werte sind ab hier **Endwerte** und werden in der Ansicht nicht mehr
   * nachskaliert. Vorher standen dort noch `* 0,56` (Ambient) und `* 0,72`
   * (Hemisphere) — zwei stille Korrekturfaktoren, die dieses Modell als
   * Lichtquelle unlesbar machten: was hier 0,24 hiess, waren im Bild 0,134.
   * Die Faktoren sind jetzt eingerechnet, es gibt nur noch eine Stelle.
   *
   * Die Nachtwerte sind bewusst exakt die bisherigen (Ambient 0,022,
   * Hemisphere 0,108). Diese Szene ist schon mehrfach nachts ins Schwarze
   * gekippt; die Umstellung fasst deshalb ausschliesslich den Tag an.
   */
  const ambient = {
    color: kelvinToHex(Math.round(3000 + daylightF * 3000)),
    // Klarer Mittag 0,05 statt bisher effektiv 0,134. Ambient ist das flachste
    // Licht der Szene — es füllt genau die Stellen auf, die den Schatten
    // ausmachen. Bei Bewölkung darf es zurückkommen, dann stimmt es auch.
    intensity: 0.022 + daylightF * 0.028 + cloudiness * 0.13,
  }
  const hemisphere = {
    skyColor: sky.zenithColor,
    groundColor: kelvinToHex(3200),
    /*
     * Am Mittag 0,56 statt bisher effektiv 0,468 — als einziges Fülllicht
     * bewusst leicht angehoben. Himmelslicht ist gerichtet (oben hell, unten
     * dunkel); es modelliert, statt zu planieren, und trifft waagerechte
     * Flächen voll. Genau dort wird es gebraucht: der Rasen bekommt an einem
     * klaren Tag real rund ein Sechstel seiner Beleuchtung aus dem blauen
     * Himmel, und ohne diesen Anteil kippt er ins Abendliche.
     *
     * Gegen die Sonne (mittags 2,18 auf eine waagerechte Fläche) steht es
     * damit bei knapp 1 : 4 — das Verhältnis eines klaren Tages.
     */
    intensity: (0.108 + daylightF * 0.452) * (1 - cloudiness * 0.2) + cloudiness * 0.22,
  }

  /*
   * Blende. Bezugsgrösse ist die Einstrahlung der Sonne auf eine waagerechte
   * Fläche, `sunIntensity × sin(Höhe)` — mittags rund 2,2, nachmittags um
   * 16 Uhr nur noch 0,75.
   *
   * Der Zähler 9,0 liegt bewusst über dem Mittagswert: das Bild soll auch am
   * Mittag mit gut 1,2 belichtet werden, weil das weggefallene Fülllicht sonst
   * als Gesamtabdunklung übrig bliebe — die Bildmitte lag ohne Nachbelichtung
   * bei 68 von 255 statt bei rund 90. Der flache Exponent 0,28 lässt einen
   * tiefen Sonnenstand *sichtbar* dunkler bleiben, statt ihn wegzurechnen; die
   * Obergrenze 1,75 ist der Punkt, an dem die Golden Hour lieber warm und tief
   * bleibt, als auf Mittagshelligkeit hochgezogen zu werden.
   */
  const exposure = above
    ? Math.min(1.75, Math.max(1, Math.pow(9.0 / Math.max(0.18, sunIntensity * Math.max(0, pos.direction.y)), 0.28)))
    : 1

  return {
    time: { hour, dayOfYear: doy },
    sun: {
      azimuth: pos.azimuth,
      elevation,
      aboveHorizon: above,
      direction: pos.direction,
    },
    phase,
    weather: { condition, cloudiness },
    sky,
    lighting: {
      ambient,
      hemisphere,
      sun: { color: sunColor, intensity: sunIntensity, castShadow: above, shadowIntensity },
      exteriorAlbedoScale: exteriorLightScale(elevation),
      exposure,
    },
  }
}
