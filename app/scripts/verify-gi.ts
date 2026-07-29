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
import { hexToRgb, skyEnvIntensity, skyIrradiance, skyRadiance, srgbToLinear, type Rgb, type SkyModel } from '../src/lib/skyModel'

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

/* ── Die eigentliche Prüfung ────────────────────────────────────────────
 *
 * `skyEnvIntensity` rechnet den Faktor aus derselben Formel, die den Himmel
 * zeichnet. Wenn das stimmt, muss die gelieferte Beleuchtungsstärke zu **jeder**
 * Tageszeit denselben Anteil des Hemisphärenlichts treffen — unabhängig davon,
 * wie stark das Verhältnis oben schwankt. Genau das ist hier die Behauptung.
 */
const SHARE = 0.66
console.log('\n══ Gerechnete Stärke — trifft sie den Zielanteil zu jeder Tageszeit?')
console.log(`   Zielanteil ${Math.round(SHARE * 100)} % der bisherigen Umgebungshelligkeit\n`)
console.log('   Fall                envMapIntensity   geliefert   Ziel      Abweichung')

let worstErr = 0
for (const [label, hour, weather] of CASES) {
  const env = deriveEnvironment({ timeOfDay: hour, weather })
  const sky: SkyModel = {
    zenith: hexToRgb(env.sky.zenithColor),
    horizon: hexToRgb(env.sky.horizonColor),
    cloudiness: env.weather.cloudiness,
    groundAlbedo: LAWN,
  }
  const hemiColour = hexToRgb(env.lighting.hemisphere.skyColor)
  const hemiI = env.lighting.hemisphere.intensity * 0.72
  const k = skyEnvIntensity(sky, hemiColour, hemiI, SHARE)
  const delivered = lum(skyIrradiance(sky)) * k
  const target = lum(hemiColour) * hemiI * SHARE
  const err = target > 0.02 ? Math.abs(delivered - target) / target : 0
  worstErr = Math.max(worstErr, err)
  console.log(
    `   ${label.padEnd(18)} ${k.toFixed(3).padStart(9)}   ${delivered.toFixed(1).padStart(9)}   ${target.toFixed(1).padStart(6)}    ${(err * 100).toFixed(1)} %`,
  )
}

console.log('\n══ Befund')
check(
  worstErr < 0.02,
  'Belichtung tageszeitfest',
  `grösste Abweichung ${(worstErr * 100).toFixed(1)} % (die Spreizung von ${spread.toFixed(1)}× ist herausgerechnet)`,
)

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
 * Nachts darf der Himmel die Szene nicht aufhellen. Das ist die Probe darauf,
 * dass die Beleuchtungsstärke wirklich aus der Karte kommt und nicht aus einer
 * Konstanten: eine Karte mit nächtlichen Farben muss von selbst dunkel sein.
 */
const night = deriveEnvironment({ timeOfDay: 1, weather: 'clear' })
const nightE = skyIrradiance({
  zenith: hexToRgb(night.sky.zenithColor),
  horizon: hexToRgb(night.sky.horizonColor),
  cloudiness: night.weather.cloudiness,
  groundAlbedo: LAWN,
})
const noonE = skyIrradiance({
  zenith: hexToRgb(deriveEnvironment({ timeOfDay: 12 }).sky.zenithColor),
  horizon: hexToRgb(deriveEnvironment({ timeOfDay: 12 }).sky.horizonColor),
  cloudiness: 0,
  groundAlbedo: LAWN,
})
check(
  lum(nightE) < lum(noonE) * 0.2,
  'Nacht bleibt Nacht',
  `${lum(nightE).toFixed(0)} gegen ${lum(noonE).toFixed(0)} am Mittag = ${Math.round((lum(nightE) / lum(noonE)) * 100)} %`,
)

/* ── Gemessen schlägt angenommen ────────────────────────────────────────
 *
 * Der Bodenanteil war ein angenommener Rasenwert. Liegt ein Luftbild unter der
 * Szene, ist er messbar — das Bild ist die Aufsicht auf genau diese Fläche.
 *
 * Die Zahlen unten stammen aus dem amtlichen DOP der Kolpingstr. 9 (Geobasis
 * NRW, 240 m Kante, 65 536 Stützpunkte, linear gemittelt). Sie zeigen zweierlei:
 * dass die Annahme daneben lag, und dass die Umrechnung sRGB → linear kein
 * Detail ist.
 */
console.log('\n══ Bodenreflexion — angenommen gegen gemessen')
const MEASURED: Rgb = [0.184, 0.173, 0.167]  // DOP Kolpingstr. 9
console.log(`   angenommen (Rasen)   ${LAWN.map((c) => c.toFixed(3)).join(' ')}`)
console.log(`   gemessen (DOP)       ${MEASURED.map((c) => c.toFixed(3)).join(' ')}`)
const greenBias = LAWN[1] / ((LAWN[0] + LAWN[2]) / 2)
const measuredBias = MEASURED[1] / ((MEASURED[0] + MEASURED[2]) / 2)
check(
  Math.abs(measuredBias - 1) < 0.1 && greenBias > 1.3,
  'Annahme war zu grün',
  `Grünstich angenommen ${greenBias.toFixed(2)}, gemessen ${measuredBias.toFixed(2)} — eine Wohnstraße ist überwiegend Dach und Asphalt`,
)

/*
 * Und die Umrechnung selbst. Ein Bildwert von 105 ist keine Reflexion von 41 %,
 * sondern von rund 14 % — wer die Bildwerte direkt mittelt, überschätzt den
 * Rückwurf um mehr als das Doppelte, und die Szene bekäme von unten viel zu
 * viel Licht. Der Fehler ist nicht zu sehen, nur zu rechnen.
 */
const naive = 105 / 255
const correct = srgbToLinear(105)
check(
  Math.abs(correct - 0.1413) < 0.0005,
  'sRGB → linear stimmt',
  `Bildwert 105 → ${correct.toFixed(3)} Reflexion; direkt gemittelt wären es ${naive.toFixed(3)} = ${(naive / correct).toFixed(1)}× zu hell`,
)

console.log(`\n${failures === 0 ? '✓ Die Himmelsbeleuchtung ist bilanziert.' : `✗ ${failures} Befund(e).`}`)
process.exit(failures === 0 ? 0 : 1)
