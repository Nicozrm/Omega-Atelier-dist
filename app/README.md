# OMEGA Atelier — Quelltext

Dieses Verzeichnis enthält den **Quelltext** der App. Das Repository-Root
darüber ist der **deployte Build** (Vercel liefert es als statische Site aus,
gesteuert von `vercel.json` — dort gibt es bewusst keine `package.json` und
keinen Build-Schritt).

```
/                 ← deployter Build: index.html, assets/, sw.js, models/, textures/
/app              ← dieser Quelltext
/app/src          ← die Anwendung
```

## Entwickeln

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

`predev`/`prebuild` kopieren die großen Medien (`models/`, `textures/`, Promo-
Video) automatisch aus dem Repository-Root nach `public/`. Diese Kopien sind in
`.gitignore` — die eine committete Fassung liegt im Root, weil das Root die
ausgelieferte Site ist.

## Bauen und deployen

```bash
cd app
npm run typecheck  # muss fehlerfrei sein
npm run build      # erzeugt app/dist/
```

Danach den Inhalt von `app/dist/` ins Repository-Root kopieren (alte
`assets/`, `sw.js`, `workbox-*.js` vorher löschen, damit keine verwaisten
Hash-Dateien liegen bleiben) und committen. Vercel deployt das Root unverändert.

## Umgebungsvariablen

| Variable | Zweck |
|---|---|
| `VITE_SUPABASE_URL` | Supabase-Projekt-URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase Anon-Key |

Fehlen beide, läuft die App vollständig lokal (`supabaseReady === false`);
Login, Cloud-Speicher und Realtime sind dann deaktiviert. Der aktuell
ausgelieferte Build ist ohne diese Variablen gebaut.

## Architektur in Kurzform

| Ordner | Rolle |
|---|---|
| `src/types.ts` | Das Plan-Modell — gemeinsame Sprache aller Schichten |
| `src/domain/` | Geräte-, Capability- und Connector-Domäne (herstellerneutral) |
| `src/connectors/` | Je ein Ökosystem pro Ordner, implementiert `Connector` |
| `src/twin/` | Digital-Twin-Runtime, Szenen, Sprachbefehle |
| `src/lib/` | Reine Domänenmodule ohne Renderer (Umgebung, Jahreszeit, Materialien …) |
| `src/lib/world/` | **Living World** — der prozedurale Nachbarschafts-Generator |
| `src/lib/composer/` | AI Home Composer — Analyse-Pipeline vom Kartentipp zum Projekt |
| `src/components/3d/` | Der three.js-Renderer (liest die Domänen, entscheidet nichts) |

Die Trennlinie, die überall gilt: **Domänenmodule sind rein und rendererfrei,
der Renderer trifft keine fachliche Entscheidung.** Deshalb kann derselbe
`lib/world`-Datensatz heute die 3D-Ansicht und morgen eine Verschattungs- oder
Lärmanalyse speisen.
