/**
 * skyModel — der Himmel als Lichtquelle, nicht als Bild.
 *
 * Bis hierher wurde der Aussenraum von zwei Dingen beleuchtet: einem
 * Richtungslicht für die Sonne und einem `hemisphereLight`, das den ganzen
 * übrigen Himmel durch **zwei Farben** annähert — eine für oben, eine für
 * unten, linear dazwischen. Das ist der Grund für den Eindruck „Beleuchtung
 * noch relativ flach", und zwar aus einem Grund, der sich benennen lässt:
 *
 * In der Wirklichkeit kommt der grösste Teil des Lichts an einem bewölkten
 * oder auch nur normalen Tag **nicht** von der Sonne, sondern vom Himmel und
 * vom Boden. Der Himmel ist dabei nicht zwei Farben, sondern ein Verlauf mit
 * einem hellen Band über dem Horizont, und der Boden wirft farbiges Licht
 * zurück — Rasen wirft Grün an die Hauswand, Asphalt wirft Grau. Genau dieses
 * zurückgeworfene Licht ist der Anteil, den man „Global Illumination" nennt,
 * und er fehlte vollständig.
 *
 * Diese Datei beschreibt den Himmel deshalb als **Funktion**, nicht als
 * Leinwand: `skyRadiance` gibt die Leuchtdichte in eine Richtung, `skyIrradiance`
 * integriert daraus die Beleuchtungsstärke, die eine waagerechte Fläche
 * empfängt. Der Zeichner benutzt die erste, die Prüfung die zweite — beide
 * dieselbe Formel, sonst prüfte man etwas anderes, als man zeichnet.
 *
 * Bewusst **ohne** die Sonne. Die Sonnenscheibe steckt in der gezeichneten
 * Karte, aber sie darf nicht in die Beleuchtungsrechnung: die direkte Sonne ist
 * bereits das Richtungslicht der Szene. Zweimal gezählt wäre der Aussenraum am
 * Mittag doppelt so hell.
 */

export type Rgb = [number, number, number]

export interface SkyModel {
  /** Zenitfarbe, 0…255 je Kanal. */
  zenith: Rgb
  /** Horizontfarbe, 0…255 je Kanal. */
  horizon: Rgb
  /** 0 (klar) … 1 (geschlossene Decke). */
  cloudiness: number
  /**
   * Albedo des Bodens, 0…1 je Kanal — wie viel Licht er zurückwirft.
   *
   * Rasen liegt bei etwa 0,25 und deutlich grüner als grau, Asphalt bei 0,12
   * und neutral. Der Unterschied ist an einer hellen Hauswand sichtbar: über
   * Rasen bekommt sie von unten einen grünen Anflug, über Pflaster nicht.
   */
  groundAlbedo: Rgb
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Wie schnell der Himmel vom Horizont zum Zenit umschlägt.
 *
 * `y^0.42` statt `y`: bei 10° Höhe ist er schon zu rund 40 % auf Zenitfarbe.
 * So verhält sich die reale Luftsäule — die Sichtlinie läuft dicht über dem
 * Horizont durch ein Vielfaches an Luft. Bei Bewölkung wird die Kurve flacher,
 * weil eine geschlossene Decke tatsächlich gleichmässiger leuchtet.
 */
export function skyCurve(cloudiness: number): number {
  return 0.42 + clamp01(cloudiness) * 0.34
}

/**
 * Leuchtdichte des Himmels in eine Richtung, gegeben durch ihre Höhe
 * `dy` = sin(Höhenwinkel), −1 (senkrecht nach unten) … +1 (Zenit).
 *
 * Unterhalb des Horizonts steht **kein gespiegelter Himmel**, sondern der vom
 * Boden zurückgeworfene Anteil: eine lambertsche Fläche, die vom Himmel
 * beleuchtet wird, strahlt gleichmässig mit `Albedo × Beleuchtungsstärke / π`
 * in alle Richtungen. Genau das ist hier eingesetzt — deshalb braucht die
 * Funktion die Beleuchtungsstärke der oberen Halbkugel als Eingabe und rechnet
 * sie nicht jedes Mal neu.
 */
export function skyRadiance(sky: SkyModel, dy: number, upperIrradiance: Rgb): Rgb {
  const up = Math.max(0, dy)

  if (dy >= 0) {
    const t = Math.pow(up, skyCurve(sky.cloudiness))
    const out: Rgb = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      let v = sky.horizon[c] + (sky.zenith[c] - sky.horizon[c]) * t
      // Horizontdunst: die letzten Grad über der Kante werden heller und
      // entsättigter. Das ist der Übergang, an dem eine Szene ihre Tiefe
      // bekommt — er schliesst den Nebel der Szene optisch an den Himmel an.
      const haze = Math.pow(1 - up, 9)
      const hz = 0.16 + sky.cloudiness * 0.12
      v += (sky.horizon[c] * 1.1 - v) * haze * hz
      out[c] = v
    }
    return out
  }

  /*
   * Bodenanteil — das eigentlich Neue.
   *
   * Er ist über die ganze untere Halbkugel gleich hell, weil eine matte
   * Fläche in alle Richtungen gleich abstrahlt. Zum Nadir hin wird er
   * abgedunkelt: dort sieht eine Fläche vor allem den Boden direkt unter sich,
   * und der ist durch alles, was darauf steht, teilweise verschattet.
   */
  const occl = 0.72 + 0.28 * (1 + dy) // dy = −1 → 0.72, dy = 0 → 1.0
  return [
    sky.groundAlbedo[0] * upperIrradiance[0] * occl,
    sky.groundAlbedo[1] * upperIrradiance[1] * occl,
    sky.groundAlbedo[2] * upperIrradiance[2] * occl,
  ]
}

/**
 * Beleuchtungsstärke, die eine waagerecht nach oben zeigende Fläche vom Himmel
 * empfängt — cosinusgewichtetes Integral der Leuchtdichte über die obere
 * Halbkugel:
 *
 *     E = ∫∫ L(ω) cos θ dω = 2π ∫₀^{π/2} L(e) · sin e · cos e · de
 *
 * Die Formel ist deshalb hier ausgeschrieben, weil sie die Brücke zwischen den
 * beiden Beschreibungen ist: `hemisphereLight` in three liefert für eine nach
 * oben zeigende Normale unmittelbar `skyColor × intensity` als
 * Beleuchtungsstärke. Nur wenn beide in derselben Grösse ausgedrückt sind,
 * lässt sich sagen, ob ein Wechsel von der einen zur anderen die Szene heller
 * macht — und genau das ist die Frage, an der ein solcher Umbau sonst
 * scheitert.
 *
 * Die Sonne ist nicht enthalten (siehe Kopf der Datei).
 *
 * @param steps Stützstellen der Integration. 256 sind bei diesem glatten
 *   Verlauf weit im konvergierten Bereich.
 * @returns Beleuchtungsstärke je Kanal, in derselben 0…255-Skala wie die
 *   Farben — also direkt vergleichbar mit `skyColor × intensity`.
 */
export function skyIrradiance(sky: SkyModel, steps = 256): Rgb {
  const out: Rgb = [0, 0, 0]
  const de = Math.PI / 2 / steps
  // Der Bodenanteil spielt für die obere Halbkugel keine Rolle, also genügt
  // hier ein Nullvektor als Eingabe.
  const none: Rgb = [0, 0, 0]
  for (let i = 0; i < steps; i++) {
    const e = (i + 0.5) * de
    const L = skyRadiance(sky, Math.sin(e), none)
    const w = Math.sin(e) * Math.cos(e) * de * 2 * Math.PI
    out[0] += L[0] * w
    out[1] += L[1] * w
    out[2] += L[2] * w
  }
  // Normierung auf die 0…255-Skala: eine gleichmässig mit L leuchtende
  // Halbkugel ergibt E = π·L, damit ist E/π die vergleichbare Grösse.
  return [out[0] / Math.PI, out[1] / Math.PI, out[2] / Math.PI]
}

/** Hilfsmittel: `#rrggbb` → 0…255 je Kanal. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/**
 * Die `envMapIntensity`, mit der die Himmelskarte eine gewünschte
 * Beleuchtungsstärke liefert.
 *
 * Warum das gerechnet und nicht eingestellt wird: das Verhältnis zwischen der
 * Karte und dem Hemisphärenlicht, das sie ablöst, ist **nicht konstant**.
 * Gemessen über den Tag:
 *
 *     Mittag klar      2,96×
 *     Nachmittag klar  4,42×
 *     Mittag bedeckt   3,98×
 *     Dämmerung       11,31×
 *     Nacht           11,31×
 *
 * Der Grund liegt im Umgebungsmodell: die Intensität des Hemisphärenlichts
 * fällt nachts fast auf null, die *Farben* des Himmels behalten dagegen einen
 * Bodenwert — ein Nachthimmel ist dunkelblau, nicht schwarz. Eine feste Zahl
 * müsste sich also für einen Tageszeitpunkt entscheiden. Auf den Mittag
 * abgestimmt wäre die Nacht um das Vierfache überstrahlt, und weil das
 * gleichmässig geschieht, sähe es nicht nach einem Fehler aus, sondern nach
 * einer schlechten Belichtung — man drehte dann an der Tonwertkurve und
 * behandelte das Symptom.
 *
 * Der Faktor wird deshalb aus derselben Formel gewonnen, die auch die Karte
 * zeichnet. Damit ist die Belichtung über den ganzen Tag konstruktiv gehalten
 * und nicht durch Nachjustieren.
 *
 * @param share Wie viel der bisherigen Umgebungshelligkeit die Karte tragen
 *   soll. 1 heisst: genau so viel, wie das Hemisphärenlicht lieferte — die
 *   Menge bleibt, die *Verteilung* wird richtig.
 */
export function skyEnvIntensity(
  sky: SkyModel,
  hemisphereColour: Rgb,
  hemisphereIntensity: number,
  share = 1,
): number {
  const lum = (c: Rgb) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  const target = lum(hemisphereColour) * hemisphereIntensity * share
  const have = lum(skyIrradiance(sky))
  if (have <= 1e-6) return 0
  // Nach unten begrenzt, damit die Spiegelung in Glas nicht ganz verschwindet;
  // nach oben, damit ein Sonderfall im Umgebungsmodell die Szene nicht
  // überstrahlen kann.
  return Math.max(0.03, Math.min(1.6, target / have))
}

/**
 * sRGB-Bildwert (0…255) → lineare Reflexion (0…1).
 *
 * Nach der Norm und nicht als Gamma 2,2 — die beiden weichen in den dunklen
 * Werten spürbar ab, und Asphalt liegt genau dort.
 *
 * Warum das eine eigene, geprüfte Funktion ist: die Verwechslung von Bildwert
 * und Reflexion ist der teuerste Fehler beim Ableiten von Licht aus einem Foto,
 * und er ist nicht zu sehen, sondern nur zu rechnen. Am Luftbild der
 * Kolpingstr. 9 gemessen — 240 m Kante, 65 536 Stützpunkte:
 *
 *     Bildmittel                 104 106 106  (sRGB)
 *     Reflexion, linear          0,184 0,173 0,167
 *     direkt aus sRGB gemittelt  0,410 0,414 0,414   → **2,4× zu hell**
 *
 * Der Boden hätte also mehr als das Doppelte an Licht zurückgeworfen.
 */
export function srgbToLinear(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * Beleuchtungsstärke wie {@link skyIrradiance}, aber in **linearer** Größe.
 *
 * Der Unterschied ist keine Formsache. `skyIrradiance` rechnet in der
 * 0…255-Skala der Farbwerte, weil es dort mit `hemisphereLight` vergleichbar
 * ist. Sobald man aber gegen eine echte Umgebungskarte bilanziert, zählt, was
 * three tatsächlich verrechnet: es dekodiert jeden Texel von sRGB nach linear
 * und faltet **danach**. Ein Himmel mit dem Bildwert 125 trägt also 0,20 bei
 * und nicht 0,49 — wer in der Bildwertskala bilanziert, überschätzt ihn um mehr
 * als das Doppelte.
 */
export function skyIrradianceLinear(sky: SkyModel, steps = 256): Rgb {
  const out: Rgb = [0, 0, 0]
  const de = Math.PI / 2 / steps
  const none: Rgb = [0, 0, 0]
  for (let i = 0; i < steps; i++) {
    const e = (i + 0.5) * de
    const L = skyRadiance(sky, Math.sin(e), none)
    const w = Math.sin(e) * Math.cos(e) * de * 2 * Math.PI
    out[0] += srgbToLinear(L[0]) * w
    out[1] += srgbToLinear(L[1]) * w
    out[2] += srgbToLinear(L[2]) * w
  }
  return [out[0] / Math.PI, out[1] / Math.PI, out[2] / Math.PI]
}
