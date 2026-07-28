/**
 * dop.ts — das amtliche Luftbild als Bodentextur.
 *
 * Bis hierher war der Boden der 3D-Szene erfunden: eine Rasentextur, über die
 * der Generator Straßen und Wege gezeichnet hat. Plausibel, aber eben nicht
 * *dieser* Ort. Für einen Digital Twin ist das die letzte große Lücke — man
 * erkennt sein Zuhause nicht am Haus allein, sondern an der Einfahrt, dem
 * Pflaster, der Hecke, dem Nachbargrundstück.
 *
 * Nordrhein-Westfalen liefert genau das mit **10 cm** Bodenauflösung unter
 * dl-de/zero-2.0 (siehe `imagery.ts` für die Lizenzlage und warum es nicht
 * Google ist). Dieses Modul holt daraus einen einzelnen, exakt
 * georeferenzierten Ausschnitt, der als Textur auf die Grundebene passt.
 *
 * ## Die Falle: Web-Mercator misst keine Meter
 *
 * Der Dienst rechnet in EPSG:3857. Dort sind Distanzen um `1/cos(φ)` gestreckt
 * — auf 52° Nord also um rund **62 %**. Wer eine 200-m-Bodenkante anfordert und
 * dafür 200 Mercator-Meter einsetzt, bekommt einen Ausschnitt von nur 123 m
 * Bodenkante zurück und legt ihn dann über 200 m Szene. Das Ergebnis sieht auf
 * den ersten Blick richtig aus — ein Luftbild eben — und ist um 62 % verzerrt.
 * Häuser stünden neben ihren Umrissen, die Einfahrt läge im Vorgarten.
 *
 * Deshalb wird hier genau einmal umgerechnet, in {@link mercatorHalfSpan}, und
 * nirgends sonst.
 */

import type { GeoPoint } from '../types'
import { regionalDopsAt, type RegionalDop } from '../imagery'

/** Halber Umfang der Web-Mercator-Ebene in Metern. */
const MERC_R = 20037508.342789244

/** Ein Punkt in Web-Mercator-Metern. */
export interface MercatorPoint { x: number; y: number }

export function toMercator(at: GeoPoint): MercatorPoint {
  return {
    x: (at.lng * MERC_R) / 180,
    y: (Math.log(Math.tan(((90 + at.lat) * Math.PI) / 360)) / (Math.PI / 180)) * MERC_R / 180,
  }
}

/**
 * Wie viele **Mercator**-Meter entsprechen einer halben Kante von `groundM`
 * echten Bodenmetern auf dieser Breite?
 *
 * Das ist die einzige Stelle, an der die Streckung des Mercator-Systems
 * auftaucht. Sie hier zu vergessen ist der Fehler, der ein perfekt aussehendes,
 * aber um 62 % falsches Luftbild erzeugt.
 */
export function mercatorHalfSpan(groundM: number, lat: number): number {
  return groundM / 2 / Math.cos((lat * Math.PI) / 180)
}

/**
 * Obergrenze der Dienste für WIDTH/HEIGHT. NRW meldet 5000 in seinen
 * Capabilities; darüber antwortet ein WMS mit einem Fehler-XML und **HTTP
 * 200**, also mit etwas, das wie ein Bild aussieht, bis man den Content-Type
 * prüft.
 */
export const MAX_WMS_PX = 4096

export interface OrthophotoRequest {
  at: GeoPoint
  /** Kantenlänge des gewünschten Ausschnitts in echten Bodenmetern. */
  groundSizeM: number
  /** Gewünschte Kantenlänge in Pixeln. Wird auf {@link MAX_WMS_PX} gedeckelt. */
  pixels?: number
}

export interface Orthophoto {
  url: string
  source: RegionalDop
  /** Tatsächlich abgedeckte Bodenkante in Metern. */
  groundSizeM: number
  pixels: number
  /** Zentimeter je Pixel — zum Vergleich mit der nativen Auflösung. */
  cmPerPixel: number
}

/**
 * Baut die GetMap-Anfrage für einen quadratischen Ausschnitt um `at`.
 *
 * Nordausgerichtet und quadratisch, weil die Grundebene der Szene genau das
 * ist: eine achsparallele Fläche um den Plan-Mittelpunkt. Die Drehung des
 * Grundstücks steckt im Plan, nicht im Boden.
 */
export function orthophotoUrl(dop: RegionalDop, req: OrthophotoRequest): Orthophoto {
  const px = Math.min(Math.max(256, Math.round(req.pixels ?? 2048)), MAX_WMS_PX)
  const c = toMercator(req.at)
  const half = mercatorHalfSpan(req.groundSizeM, req.at.lat)
  const bbox = [c.x - half, c.y - half, c.x + half, c.y + half].join(',')
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: dop.layer,
    STYLES: '',
    CRS: 'EPSG:3857',
    BBOX: bbox,
    WIDTH: String(px),
    HEIGHT: String(px),
    // JPEG statt PNG: der Boden ist flächendeckend, Transparenz braucht es
    // hier nicht, und ein 2048er PNG wäre ein Vielfaches an Bytes.
    FORMAT: 'image/jpeg',
  })
  return {
    url: `${dop.base}?${q.toString()}`,
    source: dop,
    groundSizeM: req.groundSizeM,
    pixels: px,
    cmPerPixel: Math.round(((req.groundSizeM / px) * 100) * 10) / 10,
  }
}

/**
 * Alle in Frage kommenden Luftbilder, **feinste zuerst**.
 *
 * Bewusst eine Liste und keine einzelne Antwort. Die gemeldeten Hüllen der
 * Dienste sind Rechtecke über unregelmäßigen Landesgebieten und überlappen an
 * den Ecken: Hannover liegt innerhalb der von NRW gemeldeten Hülle, und wer
 * einfach die feinste Auflösung nimmt, bestellt dort ein 10-cm-Bild aus NRW —
 * und bekommt eine leere Kachel, während die zuständige niedersächsische
 * Befliegung nie gefragt wird. Bei den Kartenkacheln löst ein transparenter
 * Stapel das Problem; ein einzelnes Bodenbild kann nicht durchscheinen, also
 * muss hier geprüft werden.
 */
export function orthophotoCandidates(req: OrthophotoRequest): Orthophoto[] {
  return regionalDopsAt(req.at).reverse().map((dop) => orthophotoUrl(dop, req))
}

/**
 * Winziger Abzug desselben Ausschnitts, mit Transparenz. Außerhalb der
 * Befliegung ist er vollständig durchsichtig — das ist die verlässliche
 * Auskunft darüber, ob ein Dienst diesen Ort wirklich abdeckt. Ein paar
 * Kilobyte je Kandidat, einmal pro Szene.
 */
export function coverageProbeUrl(photo: Orthophoto, at: GeoPoint, px = 32): string {
  const c = toMercator(at)
  const half = mercatorHalfSpan(photo.groundSizeM, at.lat)
  const q = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
    LAYERS: photo.source.layer, STYLES: '', CRS: 'EPSG:3857',
    BBOX: [c.x - half, c.y - half, c.x + half, c.y + half].join(','),
    WIDTH: String(px), HEIGHT: String(px),
    FORMAT: 'image/png', TRANSPARENT: 'TRUE',
  })
  return `${photo.source.base}?${q.toString()}`
}

/**
 * Lädt den Ausschnitt als Bild. Wirft nie — ein fehlendes Luftbild ist ein
 * fehlendes Luftbild, kein Grund, die Szene scheitern zu lassen.
 *
 * `crossOrigin` ist Pflicht: ohne das Attribut ist die Textur in WebGL
 * „tainted" und three verweigert sie. Die Dienste senden die passenden
 * CORS-Kopfzeilen (geprüft in `verify:imagery`).
 */
export function loadOrthophoto(photo: Orthophoto, signal?: AbortSignal): Promise<HTMLImageElement | undefined> {
  return loadImage(photo.url, signal)
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(undefined)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    let settled = false
    const done = (v: HTMLImageElement | undefined) => {
      if (settled) return
      settled = true
      img.onload = img.onerror = null
      resolve(v)
    }
    img.onload = () => done(img)
    img.onerror = () => done(undefined)
    signal?.addEventListener('abort', () => { img.src = ''; done(undefined) }, { once: true })
    img.src = url
  })
}

/** Hat der Abzug überhaupt Inhalt, oder ist er das transparente Nichts? */
function probeHasPixels(img: HTMLImageElement): boolean {
  try {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 16
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    if (!ctx) return true
    ctx.drawImage(img, 0, 0, 16, 16)
    const { data } = ctx.getImageData(0, 0, 16, 16)
    let opaque = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) opaque++
    // Ein Rand darf durchsichtig sein; erst überwiegende Deckung zählt als
    // „dieser Dienst ist hier zuständig".
    return opaque / (data.length / 4) > 0.6
  } catch {
    return true // Auslesen verweigert — im Zweifel zeigen
  }
}

/**
 * Das Luftbild für einen Ort: der feinste Dienst, der dort **tatsächlich**
 * Pixel liefert. `undefined`, wo keiner zuständig ist — dann bleibt der
 * erzeugte Boden stehen. Wie überall in dieser Pipeline ist Fehlen kein Fehler.
 */
export async function resolveOrthophoto(
  req: OrthophotoRequest,
  signal?: AbortSignal,
): Promise<{ photo: Orthophoto; image: HTMLImageElement } | undefined> {
  for (const photo of orthophotoCandidates(req)) {
    const probe = await loadImage(coverageProbeUrl(photo, req.at), signal)
    if (signal?.aborted) return undefined
    if (!probe || !probeHasPixels(probe)) continue
    const image = await loadOrthophoto(photo, signal)
    if (image) return { photo, image }
  }
  return undefined
}
