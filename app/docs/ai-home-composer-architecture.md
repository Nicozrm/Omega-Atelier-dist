# AI Home Composer — Architektur

Status: **Entwurf zur Freigabe.** Noch nicht implementiert.
Dieses Dokument begründet jede Designentscheidung, bevor Code entsteht.

---

## 1. Befund: was der Composer heute tut

Bevor eine neue Architektur sinnvoll ist, muss klar sein, was die bestehende
wirklich leistet. Der Befund ist unangenehm, aber eindeutig.

**Der Composer analysiert kein Satellitenbild. Er analysiert überhaupt nichts.**

Die Belegkette im aktuellen Code:

| Ort | Was dort passiert |
|---|---|
| `lib/composer/onlineProvider.ts` → `capture()` | Liefert ein `SatelliteImage`, das **keine Pixel enthält** — nur `center`, `spanMeters`, `seed`, `metersPerPixel`. Es wird nie ein Tile für die Analyse geladen. |
| `lib/composer/propertyDetector.ts` | Ruft `parcelAt(image.center)` auf — das ist `lib/composer/world.ts`, ein **synthetisches Raster** aus 26 × 34 m Fantasie-Parzellen, gehasht aus den Koordinaten. |
| `lib/composer/analysisEngine.ts` → `runAnalysis()` | Liest `input.tap` und `input.view`. **`input.polygon` wird nie gelesen.** |
| `store/useComposerStore.ts:220` | Übergibt das gezeichnete Polygon brav an die Engine — wo es verfällt. |
| `lib/composer/buildingDetector.ts`, `roofDetector.ts`, … | Erfinden Geschosszahl, Dachform, Dachneigung, Garage, Terrasse aus `rng`. |
| `lib/composer/confidenceEngine.ts` | Berechnet eine Konfidenz **für erfundene Werte**. |

Konkret bedeutet das für deinen Screenshot: du hast mit sechs Punkten sauber
dein Gebäude umfahren — und die App hat das Polygon verworfen und aus einem
Hash deiner Koordinaten ein Zufallshaus gewürfelt. Die angezeigten „92 %" sind
die Konfidenz einer Erfindung.

Das ist der Grund, warum das Ergebnis sich oberflächlich anfühlt. Es ist nicht
schlecht implementiert — die Pipeline-Struktur, die Detector-Modularität und
die Determinismus-Disziplin sind gut. Es fehlt schlicht **die Verbindung zur
Realität**.

Zwei Dinge sind daran gefährlicher als das fehlende Feature:

1. **Die UI verspricht Messung.** Karte, Polygon-Werkzeug, Phasenanzeige,
   Prozentwerte — alles signalisiert Vermessung. Für ein kommerzielles Produkt
   ist das ein Haftungsthema, nicht nur ein Qualitätsthema.
2. **Es gibt keinen Ort, an dem gemessene Werte hinkönnten.** Das Datenmodell
   unterscheidet nicht zwischen *beobachtet*, *abgeleitet* und *angenommen*.
   Man könnte heute echte Daten einspeisen und niemand könnte sie von den
   erfundenen unterscheiden.

Punkt 2 ist der eigentliche Architekturmangel. Er wird unten zur zentralen
Entscheidung.

---

## 2. Die Kernentscheidung: Datenfusion statt Bildanalyse

**Entscheidung D1 — Pixelanalyse ist nicht der Primärpfad. Amtliche und offene
Vektordaten sind es.**

Der naheliegende Weg wäre: Tiles laden, Kanten finden, Dächer segmentieren.
Das wäre für Deutschland die schlechtere Lösung, und zwar deutlich.

Was für dein Grundstück (52.123 N, 7.396 O — Rheine, NRW) **bereits amtlich und
kostenfrei veröffentlicht** ist:

| Quelle | Was sie liefert | Deckt Phase |
|---|---|---|
| **LoD2-Gebäudemodelle** (NRW, alle Länder, CityGML) | Gebäudeumriss, **echte Dachform**, Firsthöhe, Traufhöhe, Geschossigkeit — vermessen, nicht geschätzt | 2 |
| **ALKIS Flurstücke** (NRW OpenGeodata) | **Echte Grundstücksgrenzen**, Fläche, Flurstücksnummer | 1 |
| **DGM1** (1 m Höhenraster) | Echtes Geländemodell: Neigung, Exposition, Höhenunterschiede, Böschungen | 3 |
| **OpenStreetMap / Overpass** | Straßen mit Klassifikation, Gehwege, Kreuzungen, Supermärkte, Bäckereien, Apotheken, Schulen, Bushaltestellen, Spielplätze, Parks, Flüsse, Bahnlinien, Gewerbe, Laternen, Adressen, `building:levels`, `roof:shape`, `roof:material` | 2, 5 |
| **Luftbild-Tiles** (Esri, bereits integriert) | Farben, Materialanmutung, Vegetationsausdehnung, Pflaster vs. Rasen vs. Kies | 3, 4 |

Eine Bildanalyse im Browser würde all das **schlechter rekonstruieren, als es
bereits vorliegt.** Google und Apple machen es genauso: Imagery ist eine Ebene
unter vielen, und dort wo Vektordaten existieren, dominieren sie.

Das Luftbild bleibt Quelle — aber für das, wofür es gut ist: Farbe, Material,
Vegetation, und als **Fallback für Regionen ohne Vektordeckung**.

**Konsequenz:** Der Composer ist eine **Datenfusions-Engine**, kein
Computer-Vision-System. Das ändert die gesamte Modulstruktur.

---

## 3. Das tragende Prinzip: Provenienz ist Teil des Modells

**Entscheidung D2 — Jedes Attribut trägt seine Herkunft. Konfidenz wird
abgeleitet, nie erfunden.**

Das ist die wichtigste einzelne Entscheidung dieses Dokuments.

```ts
/** Woher ein Wert stammt — die Grundlage jeder Vertrauensaussage. */
export type Provenance =
  | 'measured'   // aus einer autoritativen Quelle übernommen (LoD2, ALKIS, DGM)
  | 'observed'   // aus Rohdaten abgeleitet, die wir selbst ausgewertet haben
  | 'inferred'   // modelliert aus Beobachtungen (Dachneigung aus Schattenlänge)
  | 'assumed'    // regionale Annahme, weil nichts beobachtbar war
  | 'user'       // vom Nutzer gesetzt — schlägt alles andere

export interface Attr<T> {
  value: T
  provenance: Provenance
  /** 0…1. Bei 'measured' aus der Quellgenauigkeit, bei 'assumed' aus der Streuung. */
  confidence: number
  /** Welche Quelle, in welcher Version, wann abgerufen. */
  source?: SourceRef
}
```

Warum das trägt:

* **Ehrliche UI wird trivial.** „Dachform: Satteldach · amtlich vermessen (LoD2)"
  neben „Innenaufteilung: geschätzt · 38 %". Der Nutzer weiß jederzeit, was er
  prüfen muss. Das ist genau die Information, die heute fehlt.
* **Der Generator wird legitim.** Die Living World aus `lib/world/` ist nichts
  anderes als der `assumed`-Zweig derselben Pipeline. Erfundene Nachbarhäuser
  sind kein Betrug mehr, sobald sie als `assumed` gekennzeichnet sind — sie
  sind eine bewusste, sichtbare Annahme.
* **Verbesserung wird messbar.** Ein neuer Detektor verschiebt Attribute von
  `assumed` nach `measured`. Man kann den Fortschritt beziffern, statt ihn zu
  behaupten.
* **Re-Analyse zerstört nichts.** `user` schlägt alles — dazu D8.

**Entscheidung D3 — Konfidenz wird nicht mehr geschätzt, sondern aus Provenienz
und Quellgenauigkeit berechnet.** `confidenceEngine.ts` in seiner heutigen Form
entfällt ersatzlos; es misst nichts.

---

## 4. Das Datenmodell

### 4.1 Zwei Dokumente, nicht eins

**Entscheidung D4 — `SiteDocument` enthält `PlanDocument`. Der bestehende
Plan wird nicht angefasst.**

Das heutige `PlanDocument` (Floors → Walls/Rooms/Devices) ist ein **Innenraum-
Modell**. Es kann keinen Baum, keinen Bordstein, kein Nachbardach und keine
Stromleitung ausdrücken. Man könnte es aufblähen — das wäre falsch. Der
Innenraum ist ein Gebäudeteil, nicht der Ort.

```
SiteDocument                    ← der Ort (neu)
├── crs / origin                  Georeferenz, lokaler metrischer Frame
├── entities: Entity[]            alles Räumliche
├── relations: Relation[]         typisierte Kanten zwischen Entities
├── sources: SourceRef[]          welche Quelle, welche Version, wann
└── overrides: Override[]         Nutzerkorrekturen als eigener Layer

Entity „building.own"
└── components.interior → PlanDocument   ← der bestehende Editor, unverändert
```

Damit bleibt alles Bestehende gültig: Editor, Geräte, Modi, 3D-Innenansicht,
Connectors. Der Composer erzeugt künftig ein `SiteDocument`, dessen eine
Gebäude-Entity ein `PlanDocument` trägt.

### 4.2 Entity-Component statt Klassenhierarchie

**Entscheidung D5 — Entities sind Komponenten-Container, keine Typhierarchie.**

Eine Garage ist Gebäude *und* Stellplatz. Eine Mauer ist Stützmauer *und*
Grundstücksgrenze. Ein Carport ist überdacht, aber kein Vollgeschoss. Eine
Klassenhierarchie kämpft gegen diese Realität; Komponenten bilden sie ab.

```ts
export interface Entity {
  id: EntityId
  /** Grobe Rolle — für Filter und Rendering-Auswahl, nicht für Logik. */
  kind: EntityKind          // 'parcel' | 'building' | 'roof' | 'road' | 'tree' | …
  /** Georeferenzierte Geometrie im lokalen metrischen Frame. */
  geometry: Geometry        // Point | Polyline | Polygon | Prism | Mesh
  transform: Transform      // position, rotationY, scale
  components: Components    // siehe unten — alles optional
  attrs: Record<string, Attr<unknown>>
  /** Welche Quelle diese Entity erzeugt hat. */
  origin: SourceRef
}

export interface Components {
  building?: { levels: Attr<number>; heightM: Attr<number>; use: Attr<BuildingUse> }
  roof?: { shape: Attr<RoofShape>; pitchDeg: Attr<number>; ridgeHeightM: Attr<number> }
  surface?: { material: Attr<SurfaceMaterial>; areaSqm: Attr<number> }
  vegetation?: { species: Attr<TreeKind>; crownRadiusM: Attr<number>; heightM: Attr<number> }
  road?: { classification: Attr<RoadClass>; lanes: Attr<number>; surface: Attr<string> }
  poi?: { category: Attr<PoiCategory>; name?: Attr<string>; openingHours?: Attr<string> }
  utility?: { kind: Attr<UtilityKind> }        // Laterne, Trafo, Hydrant, Freileitung
  terrain?: { elevationM: Attr<number>; slopeDeg: Attr<number> }
  interior?: { plan: PlanDocument }             // ← der bestehende Editor
  smartHome?: { deviceIds: string[] }
}
```

### 4.3 Beziehungen sind explizit

**Entscheidung D6 — Relationen sind typisierte Kanten, keine impliziten
Positionsvergleiche.**

Genau hier entsteht der Wert, den ein reiner Renderer nie hätte:

```ts
export type RelationKind =
  | 'contains'        // Flurstück enthält Gebäude
  | 'partOf'          // Garage ist Teil von Gebäude
  | 'accessedFrom'    // Einfahrt → Straße
  | 'adjacentTo'      // Nachbargebäude
  | 'shades'          // Baum verschattet Fenster   ← Verschattungsanalyse
  | 'facesOnto'       // Terrasse zeigt auf Garten
  | 'servedBy'        // Grundstück ← Bushaltestelle (Erreichbarkeit)
  | 'connectsTo'      // Straße ↔ Straße (Verkehrsgraph)
```

`shades` erlaubt Verschattungs- und Ertragsanalysen. `servedBy` erlaubt
Erreichbarkeits-Scores. `connectsTo` ist derselbe Graph, auf dem heute schon
der Verkehr in `lib/world/traffic.ts` fährt. Ohne explizite Kanten müsste jede
Auswertung die Beziehungen erneut aus Koordinaten raten.

---

## 5. Die Pipeline

**Entscheidung D7 — Die Engine ist ein Abhängigkeits-DAG, kein linearer
Phasenlauf. Die sechs Phasen bleiben die UI-Erzählung.**

Der heutige Lauf ist streng sequenziell: fällt ein Schritt aus, fällt alles aus.
Bei echten externen Quellen ist Ausfall der Normalfall — Overpass ist
überlastet, LoD2 deckt die Region nicht ab, DGM fehlt. Ein DAG degradiert
zweigweise:

```
                 ┌─ ALKIS ──────► ParcelResolver ──┐
  Anfrage ───────┼─ LoD2 ───────► BuildingResolver ┼──► Fusion ──► SiteDocument
  (Polygon,      ├─ OSM/Overpass► ContextResolver ─┤      ▲
   Zelle)        ├─ DGM1 ───────► TerrainResolver ─┤      │
                 └─ Tiles ──────► ImageryResolver ─┘      │
                                                          │
                          lib/world (Generator) ──────────┘
                          liefert `assumed` für alles Fehlende
```

Drei Ebenen, klar getrennt:

1. **Sources** — holen Rohdaten, kennen HTTP, Formate, Rate-Limits, Caching.
   Kennen die Domäne nicht.
2. **Resolvers** — übersetzen eine Quelle in `Observation`s. Kennen genau ein
   Format. Ein Resolver pro Quelle, austauschbar, einzeln testbar.
3. **Fusion** — führt Observations pro Attribut zusammen und wählt nach
   Provenienz-Rang und Quellgenauigkeit. Kennt keine Quelle.

Der Living-World-Generator wird **die unterste Quelle**: alles, was keine
Beobachtung liefert, füllt er als `assumed`. Damit ist das Ergebnis **immer**
vollständig und immer ehrlich etikettiert — und die Arbeit aus Sprint 1 ist
kein Parallelweg, sondern die Annahmeschicht dieser Pipeline.

### 5.1 Die sechs Phasen auf das Modell abgebildet

| Phase | Primärquelle | Fallback | Ergebnis-Entities |
|---|---|---|---|
| 1 Grundstück | ALKIS · **dein Polygon** | OSM `landuse` → Generator | `parcel`, `boundary`, `driveway` |
| 2 Gebäude | LoD2 | OSM `building` + `building:levels` → Generator | `building`, `roof`, `annex`, `garage`, `balcony` |
| 3 Gelände | DGM1 | Neigung 0, Tiles für Beläge | `terrain`, `retainingWall`, `terrace`, `path`, `paving` |
| 4 Vegetation | OSM `natural=tree`, `barrier=hedge` | Tile-Grünanalyse → Generator | `tree`, `hedge`, `bush`, `bed`, `wood` |
| 5 Nachbarschaft | OSM (Straßen, POI, ÖPNV, Bahn, Gewerbe) | Generator | `road`, `sidewalk`, `junction`, `poi`, `busStop`, `railway`, `river`, `utility` |
| 6 Digital Twin | — | — | Fusion → `SiteDocument` + Relationen |

**Dein gezeichnetes Polygon ist ab jetzt eine `user`-Beobachtung mit höchstem
Rang.** Es schlägt ALKIS, weil du weißt, was dir gehört. Das ist die kleinste
und zugleich wirkungsvollste Einzeländerung des ganzen Entwurfs.

---

## 6. Skalierung auf Millionen Grundstücke

**Entscheidung D8 — Die Analyse läuft serverseitig und wird pro Geo-Zelle
gecacht, nicht pro Nutzer und nicht pro Session.**

Im Browser ist das nicht tragfähig: CORS, Rate-Limits, keine gemeinsame
Nutzung, kein Cache über Sessions, LoD2-Kacheln in zweistelliger MB-Größe.

Der Schnitt:

| Ebene | Läuft wo | Aufgabe |
|---|---|---|
| Sources + Resolvers | **Supabase Edge Function** | Quellen holen, normalisieren |
| Cache | **Postgres + PostGIS** | Observations pro Zelle, mit Quellversion |
| Fusion | Edge Function | Observations → `SiteDocument` |
| Overrides + Editor | Browser | Nutzeränderungen |
| Renderer | Browser | `SiteDocument` → Szene |

Supabase ist bereits im Stack (`lib/supabase.ts`), es kommt also keine neue
Infrastruktur dazu.

**Räumliche Schlüssel statt Nutzerschlüssel.** Cache-Key ist eine
Geo-Zelle (H3 Level 11 ≈ 25 m, oder Quadkey z16) plus Quellversion. Zwei
Nachbarn, die ihr Haus analysieren, teilen sich die gesamte
Nachbarschaftsabfrage — genau ein Overpass-Call für den Straßenzug statt zwei.
Bei Millionen Grundstücken ist das der Unterschied zwischen tragfähig und
unbezahlbar.

**Inkrementelle Gültigkeit.** Jede Observation trägt `fetchedAt` und
`sourceVersion`. Wird LoD2 neu veröffentlicht, verfallen gezielt die betroffenen
Zellen — nicht der ganze Cache, und Nutzer-Overrides nie.

---

## 7. Editierbarkeit

**Entscheidung D9 — Nutzerkorrekturen sind ein eigener Layer, keine Mutation
der Beobachtung.**

Wenn du die Dachform von Walm auf Sattel korrigierst, darf die Beobachtung
nicht überschrieben werden. Sonst gilt:

* eine spätere Re-Analyse mit besseren Daten zerstört deine Arbeit, **oder**
* sie findet nie statt, weil man sich das nicht traut.

Beides ist inakzeptabel. Stattdessen:

```ts
export interface Override {
  entityId: EntityId
  path: string            // 'components.roof.shape'
  value: unknown
  at: string
  note?: string
}
```

Die Fusion legt Overrides zuletzt auf. Ergebnis: Re-Analyse ist jederzeit
gefahrlos, die UI kann „von dir korrigiert" ausweisen, und ein Zurücksetzen auf
den Messwert ist ein Löschen statt einer Rekonstruktion.

---

## 8. Migration — was bleibt, was geht, was kommt

Nichts davon erfordert einen Neuanfang. Der bestehende Code ist an den meisten
Stellen gut; er ist nur an die falsche Datenquelle angeschlossen.

| Bestehend | Schicksal |
|---|---|
| `MapCanvas`, Polygon-Werkzeug, Wizard-UI | **Bleibt.** Funktioniert, sieht gut aus, wird endlich ausgewertet. |
| `onlineProvider.ts` (Esri, Nominatim) | **Bleibt** als Imagery- und Geocoding-Quelle. |
| `analysisEngine.ts` (Phasen, Progress, Abbruch) | **Bleibt** als Orchestrierung, bekommt einen DAG statt einer Kette. |
| `world.ts` (synthetisches Parzellenraster) | **Entfällt.** Ersetzt durch echte Parzellen bzw. `lib/world`. |
| `propertyDetector`, `buildingDetector`, `roofDetector`, `terrainDetector`, `vegetationDetector` | **Werden zu Resolvern** mit echten Quellen. Struktur bleibt, Inhalt wird real. |
| `confidenceEngine.ts` | **Entfällt.** Konfidenz kommt aus Provenienz. |
| `sceneBuilder`, `projectGenerator` | **Bleiben**, konsumieren künftig `SiteDocument` statt `DetectedScene`. |
| `lib/world/` (Living World) | **Wird zur Annahmeschicht** der Pipeline. |
| `PlanDocument`, Editor, Connectors, Modi | **Unverändert.** |

---

## 9. Vorgeschlagene Reihenfolge

Jeder Schritt ist für sich auslieferbar und für sich sichtbar.

**Slice 1 — Ehrlichkeit (klein, sofort spürbar).**
`Attr<T>` + `Provenance` einführen. Bestehende Detektoren liefern `assumed`.
UI zeigt Herkunft statt erfundener Prozente. **Dein Polygon wird ausgewertet**
und ersetzt das synthetische Parzellenraster.
→ Danach lügt die App nicht mehr, und dein gezeichnetes Grundstück stimmt.

**Slice 2 — Erste echte Quelle.**
OSM/Overpass als Edge Function mit Zell-Cache. Liefert Gebäudeumriss,
Geschosse, Straßen, POI, ÖPNV. Deckt Phase 5 fast vollständig und Phase 2 zur
Hälfte.
→ Danach ist die Nachbarschaft **deine** Nachbarschaft.

**Slice 3 — Amtliche Gebäudegeometrie.**
LoD2 für NRW. Echte Dachform, Firsthöhe, Traufhöhe.
→ Danach stimmt dein Haus.

**Slice 4 — Gelände.**
DGM1 → Neigung, Höhenprofil, Böschungen, Terrassen.

**Slice 5 — `SiteDocument` + Relationen.**
Der vollständige Twin mit Kanten; Verschattung und Erreichbarkeit werden
möglich.

**Slice 6 — Overrides.**
Nutzerkorrekturen als Layer, Re-Analyse gefahrlos.

---

## 10. Offene Entscheidungen

Diese drei Punkte gehören dir, nicht mir:

1. **Backend.** Supabase Edge Functions + PostGIS ist der naheliegende Weg, weil
   Supabase bereits im Stack ist. Zustimmung?
2. **Regionale Priorität.** Zuerst NRW in voller Tiefe (LoD2 + ALKIS + DGM —
   dein eigenes Grundstück wird exakt), oder zuerst OSM europaweit in halber
   Tiefe (mehr Nutzer, weniger Präzision)?
3. **Umgang mit Nicht-Deckung.** Wenn für eine Region nur OSM existiert: soll
   der Generator die Lücken sichtbar als Annahme füllen (mein Vorschlag), oder
   soll die App die fehlende Deckung offen ausweisen und weniger zeigen?

---

## Anhang: Datenquellen mit Lizenz

| Quelle | Lizenz | Bemerkung |
|---|---|---|
| OpenStreetMap / Overpass | ODbL | Namensnennung nötig, Share-Alike bei abgeleiteten Datenbanken beachten |
| ALKIS NRW (OpenGeodata) | dl-de/zero-2.0 | frei, ohne Namensnennungspflicht |
| LoD2 NRW | dl-de/zero-2.0 | CityGML, kachelweise |
| DGM1 NRW | dl-de/zero-2.0 | 1 m Raster |
| Esri World Imagery | Esri-Nutzungsbedingungen | Anzeige mit Attribution erlaubt — bereits umgesetzt |

Google- und Apple-Kacheln sind bewusst nicht dabei: ihre Nutzungsbedingungen
binden sie an die jeweiligen SDKs. Deshalb Esri.
