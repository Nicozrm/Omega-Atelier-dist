/**
 * verify-gi.ts — wird die Szene heller, wenn der Himmel sie beleuchtet?
 *
 * Der Aussenraum wurde bisher von einem `hemisphereLight` beleuchtet: der ganze
 * Himmel angenähert durch **zwei Farben**, oben und unten, linear dazwischen.
 * Ersetzt man das durch die echte Himmelskarte, gewinnt man den Verlauf, das
 * helle Band über dem Horizont und das vom Boden zurückgeworfene Licht — den
 * Anteil also, den man Global Illumination nennt.
 *
 * Nur hat ein solcher Umbau eine Falle, an der er sonst scheitert: **doppelt
 * gezähltes Licht.** Kommt die Himmelsbeleuchtung dazu, ohne dass das
 * Hemisphärenlicht weicht, ist die Szene am Mittag doppelt so hell, und weil
 * das gleichmässig passiert, sieht es nicht nach einem Fehler aus, sondern nach
 * einer schlechten Belichtung. Man dreht dann an der Tonwertkurve und behandelt
 * das Symptom.
 *
 * Deshalb wird hier gerechnet statt geschaut. Beide Beschreibungen lassen sich
 * in dieselbe Grösse bringen — die Beleuchtungsstärke, die eine waagerecht nach
 * oben zeigende Fläche empfängt:
 *
 *   • `hemisphereLight` liefert in three für eine nach oben zeigende Normale
 *     unmittelbar `skyColor × intensity`.
 *   • Eine Umgebungskarte liefert das cosinusgewichtete Integral ihrer
 *     Leuchtdichte über die obere Halbkugel (`skyIrradiance`).
 *
 * Ausführen:  npx vite-node@2 scripts/verify-gi.ts
 */

import { deriveEnvironment } from '../src/lib/environment'
import { hexToRgb, skyIrradiance, skyIrradianceLinear, skyRadiance, srgbToLinear, type Rgb, type SkyModel } from '../src/lib/skyModel'

/** Rasen — der häufigste Untergrund einer Wohnsiedlung. */
const LAWN: Rgb = [0.19, 0.25, 0.14]
/** Asphalt — dunkler und neutral, zum Vergleich. */
const ASPHALT: Rgb = [0.12, 0.12, 0.12]

const lum = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
const fmt = (c: Rgb) => `${c[0].toFixed(0).padStart(3)} ${c[1].toFixed(0).padStart(3)} ${c[2].toFixed(0).padStart(3)}`

let failures = 0
const check = (ok: boolean, what: string, detail: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${what.padEnd(30)} ${detail}`)
  if (!ok) failures++
}

const CASES: [string, number, 'clear' | 'overcast'][] = [
  ['Mittag klar', 12, 'clear'],
  ['Nachmittag klar', 16, 'clear'],
  ['Mittag bedeckt', 12, 'overcast'],
  ['Dämmerung', 20, 'clear'],
  ['Nacht', 1, 'clear'],
]

console.log('══ Beleuchtungsstärke: Hemisphärenlicht gegen echten Himmel')
console.log('   (0…255-Skala, waagerechte Fläche nach oben)\n')
console.log('   Fall                Hemisphäre   Himmel-IBL   Verhältnis')

const ratios: number[] = []
for (const [label, hour, weather] of CASES) {
  const env = deriveEnvironment({ timeOfDay: hour, weather })
  const sky: SkyModel = {
    zenith: hexToRgb(env.sky.zenithColor),
    horizon: hexToRgb(env.sky.horizonColor),
    cloudiness: env.weather.cloudiness,
    groundAlbedo: LAWN,
  }
  const ibl = skyIrradiance(sky)
  // So, wie die Szene das Hemisphärenlicht heute setzt (ThreeDView):
  // Farbe des Modells, Intensität mal 0,72.
  const hemiColour = hexToRgb(env.lighting.hemisphere.skyColor)
  const i = env.lighting.hemisphere.intensity * 0.72
  const hemi: Rgb = [hemiColour[0] * i, hemiColour[1] * i, hemiColour[2] * i]

  const ratio = lum(ibl) / Math.max(1e-6, lum(hemi))
  ratios.push(ratio)
  console.log(`   ${label.padEnd(18)} ${fmt(hemi)}  ${fmt(ibl)}   ${ratio.toFixed(2)}×`)
}

const spread = Math.max(...ratios) / Math.min(...ratios)
console.log(`\n   Spreizung über den Tag: ${spread.toFixed(1)}×`)
console.log('   → eine **feste** envMapIntensity ist damit ausgeschlossen. Auf den')
console.log('     Mittag abgestimmt wäre die Nacht um das Vierfache überstrahlt.')

/* ── Die Falle, in die ich gelaufen bin ────────────────────────────────
 *
 * Ich habe die Himmelskarte an **alle** Aussenmaterialien gehängt, auch an die
 * diffusen, und ihre Stärke gegen das Hemisphärenlicht bemessen. Das war die
 * falsche Bezugsgrösse, und zwar auf eine Art, die man dem Code nicht ansieht:
 *
 *   Eine eigene `envMap` am Material **ersetzt** `scene.environment`.
 *
 * Der Beitrag, den man verdrängt, ist also nicht das Hemisphärenlicht, sondern
 * die Archviz-Box — und die ist um ein Vielfaches heller. Ergebnis: praktisch
 * das gesamte Umgebungslicht des Aussenraums war weg, jede Klinkerwand las sich
 * als flache Farbe, und im Bild sah es nach „schlechteren Texturen" aus.
 *
 * Beide Grössen linear, so wie three sie verrechnet — es dekodiert jeden Texel
 * von sRGB nach linear und faltet danach. Wer in der Bildwertskala bilanziert,
 * überschätzt den Himmel zusätzlich um mehr als das Doppelte.
 */
const BOX_IRRADIANCE = 1.396 // Innenraum-Box, Studio-Preset, hemisphärisch integriert
console.log('\n══ Umgebungslicht — was eine eigene envMap verdrängt')
console.log(`   Innenraum-Box (scene.environment)   ${BOX_IRRADIANCE.toFixed(3)} linear\n`)
console.log('   Fall                Himmel linear   nötige Stärke   gesetzt war')
let worstFactor = 0
for (const [label, hour, weather] of CASES) {
  const env = deriveEnvironment({ timeOfDay: hour, weather })
  const E = skyIrradianceLinear({
    zenith: hexToRgb(env.sky.zenithColor),
    horizon: hexToRgb(env.sky.horizonColor),
    cloudiness: env.weather.cloudiness,
    groundAlbedo: LAWN,
  })
  const have = lum(E)
  const need = BOX_IRRADIANCE / Math.max(1e-6, have)
  worstFactor = Math.max(worstFactor, need)
  console.log(`   ${label.padEnd(18)} ${have.toFixed(3).padStart(9)}   ${need.toFixed(1).padStart(9)}×      0,15 – 0,22`)
}
check(
  worstFactor > 5,
  'Bezugsgrösse belegt',
  `die Box ist ${worstFactor.toFixed(0)}× heller als der Himmel — deshalb bleibt sie für alles Diffuse stehen`,
)
console.log('   → Der Himmel liegt nur noch auf spiegelnden Materialien (Glas,')
console.log('     Wasser, Lack, Metall). Dort ist er ein Spiegelbild und keine')
console.log('     Lichtmenge, und dort ersetzt er das Fotostudio zu Recht.')

/* ── Der eigentlich neue Anteil ─────────────────────────────────────────
 *
 * Rückwurf vom Boden. Das Hemisphärenlicht hat dafür eine feste graue
 * `groundColor`; die Karte hat den tatsächlichen Bodenton, vom Himmel
 * beleuchtet. Der Unterschied ist das, was eine Hauswand über Rasen von einer
 * über Asphalt unterscheidet — und er war vorher schlicht nicht vorhanden.
 */
console.log('\n══ Bodenrückwurf — der Anteil, den es vorher gar nicht gab')
const env = deriveEnvironment({ timeOfDay: 13, weather: 'clear' })
const base = {
  zenith: hexToRgb(env.sky.zenithColor),
  horizon: hexToRgb(env.sky.horizonColor),
  cloudiness: env.weather.cloudiness,
}
const upper = skyIrradiance({ ...base, groundAlbedo: LAWN })
for (const [name, albedo] of [['Rasen', LAWN], ['Asphalt', ASPHALT]] as [string, Rgb][]) {
  const below = skyRadiance({ ...base, groundAlbedo: albedo }, -0.5, upper)
  console.log(`   ${name.padEnd(10)} wirft zurück  ${fmt(below)}`)
}
const g = skyRadiance({ ...base, groundAlbedo: LAWN }, -0.5, upper)
check(
  g[1] > g[2] && g[1] > g[0],
  'Rasen wirft grün zurück',
  `Grünkanal ${g[1].toFixed(0)} über Rot ${g[0].toFixed(0)} und Blau ${g[2].toFixed(0)}`,
)

/*
 * Nachts darf der Himmel die Szene nicht aufhellen.
 *
 * Gemessen wird **linear**, nicht in Bildwerten. Das ist keine Feinheit: sRGB
 * ist eine Wahrnehmungscodierung, und sie spreizt die dunklen Werte stark
 * auseinander. Derselbe Nachthimmel steht in Bildwerten bei 24 % des Mittags
 * und in Lichtmenge bei 6 % — nur die zweite Zahl beantwortet die Frage „wie
 * viel Licht fällt auf die Szene", und nur sie ist das, was three integriert.
 *
 * Die frühere Fassung dieses Tests hat in Bildwerten verglichen und wäre am
 * angehobenen Nachthimmel angeschlagen, obwohl die Lichtmenge weit im Rahmen
 * liegt.
 */
const nightSky = deriveEnvironment({ timeOfDay: 1, weather: 'clear' })
const noonSky = deriveEnvironment({ timeOfDay: 12, weather: 'clear' })
const nightE = skyIrradianceLinear({
  zenith: hexToRgb(nightSky.sky.zenithColor),
  horizon: hexToRgb(nightSky.sky.horizonColor),
  cloudiness: nightSky.weather.cloudiness,
  groundAlbedo: LAWN,
})
const noonE = skyIrradianceLinear({
  zenith: hexToRgb(noonSky.sky.zenithColor),
  horizon: hexToRgb(noonSky.sky.horizonColor),
  cloudiness: 0,
  groundAlbedo: LAWN,
})
const nightShare = lum(nightE) / lum(noonE)
check(
  nightShare < 0.15,
  'Nacht bleibt Nacht',
  `${(nightShare * 100).toFixed(1)} % der Mittagslichtmenge (in Bildwerten wären es ${
    Math.round((lum(skyIrradiance({ zenith: hexToRgb(nightSky.sky.zenithColor), horizon: hexToRgb(nightSky.sky.horizonColor), cloudiness: 0, groundAlbedo: LAWN }))
      / lum(skyIrradiance({ zenith: hexToRgb(noonSky.sky.zenithColor), horizon: hexToRgb(noonSky.sky.horizonColor), cloudiness: 0, groundAlbedo: LAWN }))) * 100)
  } % — deshalb linear)`,
)

/*
 * Und die Gegenprobe zum Anlass: der Nachthimmel muss **sichtbar** sein.
 * Ein Himmel unter etwa Bildwert 20 ist auf einem Telefon nicht von Schwarz zu
 * unterscheiden, und ohne sichtbaren Himmel fehlt der Nachtszene die
 * Horizontlinie — die Dächer stehen dann vor nichts.
 */
const nightHorizon = hexToRgb(nightSky.sky.horizonColor)
check(
  Math.max(...nightHorizon) >= 24,
  'Nachthimmel sichtbar',
  `Horizont ${nightHorizon.join('/')} (vorher 19/23/34 — auf dem Bildschirm schwarz)`,
)

console.log(`\n${failures === 0 ? '✓ Die Himmelsbeleuchtung ist bilanziert.' : `✗ ${failures} Befund(e).`}`)
process.exit(failures === 0 ? 0 : 1)
