# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Code ist englisch, Text ist deutsch.**

Englisch ist alles, was der Rechner liest: Bezeichner (Variablen, Funktionen,
Komponenten, Typen, Parameter), Dateinamen und CSS-Klassen. Damit gilt für den
ganzen Baum, was in `@gsp/shared` schon immer galt — die Schemafelder sind
englisch, weil sie die API-Oberfläche bilden.

Deutsch bleibt alles, was ein Mensch liest: Kommentare, Testnamen, UI-Texte,
Commit-Nachrichten und Dokumentation. Die Oberfläche spricht Deutsch, und die
Begründungen im Code sind für den geschrieben, der sie später sucht.

Die Grenze läuft also nicht zwischen Frontend und Backend, sondern zwischen
Bezeichner und Prosa: `function replaceWorld()` mit einem deutschen Kommentar
darüber, `<button>Welt austauschen…</button>` mit `className="world__swap"`.

## Befehle

```bash
npm install                    # einmalig, npm workspaces
npm run build -w @gsp/shared   # muss vor server/web laufen, wenn Schemas geändert wurden

npm run build                  # alle Pakete
npm run rebuild                # clean + build, bei rätselhaften Typfehlern
npm run typecheck              # alle Pakete
npm test                       # Vitest über alle Pakete
```

Ein Linter ist nicht eingerichtet. Formatierung und Stil richten sich nach dem
umliegenden Code; `npm run typecheck` läuft im `strict`-Modus mit
`noUncheckedIndexedAccess`.

Einzelne Tests:

```bash
npx vitest run packages/server/src/services/paths.test.ts
npx vitest run -t "lehnt zu kurze Valheim-Passwörter ab"
npx vitest                     # Watch-Modus
```

Anwendung lokal, **ohne Docker**:

```bash
GSP_RUNTIME=fake npm run dev   # Backend :8770, Frontend :5273 mit Proxy
```

Oder gegen den Produktionsbuild:

```bash
npm run build
GSP_RUNTIME=fake GSP_DATA_DIR=/tmp/gsp GSP_WEB_ROOT=$PWD/packages/web/dist \
  node packages/server/dist/index.js
```

## Architektur

Drei Pakete, npm workspaces:

- **`packages/shared`** (`@gsp/shared`) — Zod-Schemas für REST und WebSocket, Formatierung und die **Spielvorlagen**. Wird von Backend *und* Frontend importiert; Änderungen hier erfordern `npm run build -w @gsp/shared`, sonst sehen die anderen Pakete alte Typen.
- **`packages/server`** (`@gsp/server`) — Fastify.
- **`packages/web`** (`@gsp/web`) — React, Vite, CSS Custom Properties.

### Vorlagen sind der zentrale Erweiterungspunkt

Eine Vorlage beschreibt deklarativ Image, Ports, Volumes, Formularfelder, Env-Abbildung, Startargumente, Fähigkeiten, Log-Muster, Prüfregeln und Backup-Pfade. Daraus entstehen **Anlege-Wizard, Config-Reiter und Container**.

Vorlagen sind **Daten, nicht Code**. Sie liegen als JSON in der Tabelle `templates` und werden beim Start zu lauffähigen `GameTemplate`-Objekten kompiliert:

```
DB templates ──▶ compileTemplate() ──▶ Registry ──▶ getTemplate() / listTemplates()
```

- `packages/shared/src/schema/template-definition.ts` — das Datenschema (`TemplateDefinition`)
- `packages/shared/src/templates/compile.ts` — macht daraus wieder `env()`, `logPatterns`, Prüfregeln
- `packages/shared/src/templates/*.ts` — **Startbestand**, kein Laufzeitpfad; `index.ts` führt sie in `BUILTIN_DEFINITIONS`
- `packages/server/src/services/templates.ts` — Laden, Seeding, Schlüssigkeitsprüfung

Ein weiteres Spiel braucht damit im Normalfall **gar keine Codeänderung**: es entsteht im Editor unter „Vorlagen" oder als KI-Entwurf. Siehe `docs/vorlage-hinzufuegen.md`.

**Die Registry ist ein Modul-Singleton** (`setTemplates()` / `getTemplate()`). Tests, die Vorlagen brauchen, rufen im Setup `loadBuiltinTemplates()` — sonst wirft `getTemplate()` eine `UnknownTemplateError`.

**Die Umgebung ist der Regelfall, `args` der Ausweg.** Fast jedes Image richtet sich vollständig über Env ein. Wo nicht — Terraria kennt nur `WORLD_FILENAME` und `CONFIG_FILENAME` — trägt die Vorlage `args` ein; das ersetzt das Kommando des Images. Leere Liste heißt: Kommando unangetastet lassen, sonst startete der Container ins Leere. `omitWhenEmpty` lässt bei leerem Wert **auch das Flag** entfallen, damit ein optionales Passwort nicht als `-password ""` ankommt.

**Seeding fügt nur ein, es überschreibt nie.** Fehlende mitgelieferte Vorlagen werden beim Start ergänzt, vorhandene bleiben unangetastet — sonst setzte jedes Panel-Update die Anpassungen des Betreibers lautlos zurück.

`GameTemplate` enthält Funktionen und RegExp und ist damit nicht serialisierbar. `toDescriptor()` schneidet den JSON-fähigen Teil heraus — nur der geht über `GET /api/templates` ans Frontend. Es zählt die Felder ausdrücklich auf; wer dem Descriptor ein Feld hinzufügt, muss es dort eintragen.

### Fähigkeiten statt Annahmen

Der Design-Prototyp nimmt an, dass jede Instanz eine Befehlseingabe und Mods hat. Real gilt das nur für Minecraft. `capabilities` je Vorlage steuert, was die UI zeigt:

| | `console` | `players` | `moderation` | `mods` |
| --- | --- | --- | --- | --- |
| Minecraft | `rcon` | `rcon` | ja | `plugins` |
| Valheim | `readonly` | `a2s` | nein | `bepinex` |
| Enshrouded | `readonly` | `log` | nein | `none` |
| Palworld | `rcon` | `a2s` | nein | `none` |

Ein Ausschnitt der mitgelieferten Vorlagen — eigene können jede Kombination haben.

**Nie gegen `game === '…'` prüfen, immer gegen `capabilities`.** Das gilt seit dem Vorlagenumbau auch im Backend: `games/index.ts` bedient sich an den Adaptern nach `capabilities`, nicht nach der Spiel-ID. Ein neues Spiel mit RCON, Steam-Query oder nur Log braucht deshalb **keinen eigenen Adapter** — nur eine Vorlage. Adapter werfen `UnsupportedError`, wenn etwas nicht geht; die Route beantwortet das mit 400 statt 502.

**`console` und `players` sind zwei Fragen, nicht eine.** `adapterFor()` setzt deshalb zusammen: die Spielerliste kommt vom Adapter zu `players`, `sendCommand` bei `console: 'rcon'` von RCON, Kick und Bann nur zusätzlich bei `moderation`. Bei den ersten drei Vorlagen fiel der Unterschied nicht auf, weil keine die Spalten verschieden belegte; Palworld zählt Spieler per Steam-Abfrage und nimmt Befehle per RCON entgegen.

RCON ist damit nicht mehr Minecrafts Port 25575: `adapter.rconPortName` benennt den Port aus der Vorlage (Vorgabe `rcon`, verbunden wird der **Container**-Port), `adapter.rconListCommand` und `rconListFormat` den Befehl für die Spielerliste und die Form seiner Antwort (`minecraft` oder `csv`).

### Schichten im Backend

```
routes/          REST + WebSocket, dünn — nur Validierung und Weiterleitung
services/        Geschäftslogik
  instances.ts   zentral: Lebenszyklus, Statusableitung, DTO-Aufbau
  ticker.ts      Messtakt, verteilt Schnappschüsse an WebSocket-Abonnenten
  logs.ts        Log-Stream, Zeileneinstufung, Spieler-Tracking
  jobs.ts        langlaufende Aktionen mit Fortschritt
  files.ts       Konfigurationsdateien lesen und schreiben (Config-Reiter, „Dateien")
  templates.ts   Vorlagen laden, seeden, prüfen; füllt die Registry
  vorlagen-ki.ts KI-Entwurf: Recherche mit Websuche, dann Formen
games/           pro Spiel ein Adapter (RCON, A2S, Log)
runtime/         Container-Abstraktion: DockerRuntime | FakeRuntime
db/              SQLite, handgeschriebenes SQL, Migrationen in db/index.ts
```

Der Datenfluss zur UI: `Ticker` misst im Takt von `GSP_REFRESH_MS`, schickt einen Schnappschuss über `Hub` an das Thema `metrics`. Die Instanzliste selbst kommt per REST; die WebSocket **patcht** nur die veränderlichen Felder in den vorhandenen Zustand. Strukturänderungen lösen `instances-changed` aus, worauf das Frontend neu lädt.

### FakeRuntime

`GSP_RUNTIME=fake` ersetzt Docker durch eine Simulation im Speicher — Test-Double *und* Entwicklungsmodus. Sie erzeugt Logzeilen im **echten Format** der jeweiligen Spiele, damit dieselben Parser laufen wie in Produktion.

Diese Zeilen stammen aus `fakeLog` **derselben Vorlage** wie die Muster. Früher lagen sie in einer eigenen Tabelle im Server-Paket, und wer ein Muster änderte, musste daran denken, sie mitzupflegen — sonst testete man an der Realität vorbei. Heute prüft ein Test in `templates.test.ts`, dass die erzeugten Zeilen zu den Mustern passen, und der Vorlagendienst lehnt eine Vorlage ab, bei der das nicht stimmt.

Die Fake-Laufzeit hält Container nur im Speicher: Nach einem Neustart des Panels fehlen sie, die Instanzen gehen auf `Fehler`. Das ist gewollt — `start()` erzeugt einen fehlenden Container aus der gespeicherten Konfiguration neu.

### Volumes sind Bind-Mounts

Instanzdaten liegen unter `GSP_DATA_DIR/instances/<id>/<volume>`. Backups und Mod-Verwaltung arbeiten deshalb direkt auf Host-Pfaden statt durch den Container zu streamen.

**Fallstrick:** Läuft das Panel selbst im Container, erzeugt trotzdem der Docker-Daemon des *Hosts* die Instanz-Container und löst Bind-Mounts aus **seiner** Sicht auf. Dafür gibt es `GSP_HOST_DATA_DIR`. Wer an `createContainer()` arbeitet: Verzeichnisse lokal anlegen (`config.volumeDir`), Mounts mit `config.hostVolumeDir` eintragen.

### Design-Treue

`design_handoff_gameserver_panel/` ist die Referenz — maßgeblich ist `Gameserver Verwaltung v2.dc.html` (dunkel), die helle v1 ist nur Referenz und wird **nicht** umgesetzt. `support.js` ist Prototyping-Laufzeit und wird nicht übernommen.

Farben, Typografie und Abstände liegen als Custom Properties in `packages/web/src/styles/tokens.css`. **Keine Farbwerte direkt in Komponenten schreiben.** Zum Look gehören: `border-radius: 0` überall, keine Schatten, Tiefe entsteht über Flächenhelligkeit. Die einzige Animation ist der pulsierende Statuspunkt im Detailkopf.

Zahlen werden über `@gsp/shared/format` deutsch formatiert (`5,4 GB`, `71 h 30 m`). Das Backend liefert rohe Zahlen, die Darstellung entsteht im Frontend.

## Fallstricke

- **Der Build-Kontext muss sauber sein.** Ohne `.dockerignore` kopiert `COPY . .`
  das Host-`node_modules` und die `dist/`-Verzeichnisse über das, was `npm ci`
  und `npm run build` im Image gerade erst erzeugt haben: die mitgereiste
  `dist/.tsbuildinfo` lässt tsc nichts emittieren, die Windows-Junctions der
  Workspaces zerbrechen die Auflösung von `@gsp/shared`, und BuildKit scheitert
  auf Windows schon beim Laden des Kontexts („unknown file mode"). Neue Ordner
  mit erzeugten Dateien gehören in `.dockerignore`, nicht nur in `.gitignore`.
- **`GSP_DATA_DIR` wird vom Docker-Daemon aufgelöst, nicht vom Panel.** Unter
  Docker Desktop für Windows liegt der Daemon in einer Linux-VM; ein Pfad wie
  `D:\ServerTest` wird dort zu `/app/D:ServerTest`. Richtig ist
  `/run/desktop/mnt/host/d/ServerTest` — siehe README, Abschnitt Einstellungen.
- **`getTemplate()` kann werfen.** Seit `GameId` ein Muster statt eines Enums ist, kann eine Vorlage fehlen. Routen fangen die `UnknownTemplateError` global ab und antworten mit 404; in Tests vorher `loadBuiltinTemplates()` rufen.
- **`npm run build -w @gsp/shared` vergessen** ist die häufigste Ursache für „Cannot find module '@gsp/shared'" oder implizite `any` im Web-Paket.
- **Container-Umgebungen sind unveränderlich.** Geänderte Einstellungen wirken erst nach `recreate()` — stoppen, entfernen, neu erstellen. Weltdaten überleben das, weil sie in Bind-Mounts liegen.
- **Geheimnisse maskieren.** `maskSecrets()` ersetzt Werte von Feldern mit `secret: true` durch `********`. Der Config-Reiter schickt unveränderte Geheimnisse nicht mit zurück, sonst würde die Maske als neues Passwort gespeichert.
- **`pkill -f` trifft die eigene Shell**, wenn das Muster im Kommando vorkommt. Prozesse über eine PID-Datei beenden oder `/proc/<pid>/cmdline` prüfen.
- Playwright: Die vorinstallierte Chromium-Version passt nicht zu einer frisch installierten Playwright-Version. `chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })` benutzen, **nicht** `playwright install`.

## Verifikation

Ohne Docker prüfbar und vor jedem Commit erwartet:

```bash
npm run rebuild && npm run typecheck && npm test
```

Für Änderungen an der Oberfläche zusätzlich ein Durchlauf mit Playwright gegen `GSP_RUNTIME=fake` — anmelden, Instanz über den Wizard anlegen, Reiter durchklicken, Screenshots ansehen. Ein Vorgehen dafür steht in `docs/entwicklungsprotokoll.md`.

Echte Docker-Container lassen sich in dieser Umgebung **nicht** prüfen (kein Daemon). Was auf einer Maschine mit Docker zu testen ist, steht im README unter „Schnellstart"; solche Punkte im Bericht ausdrücklich als ungeprüft kennzeichnen.

## KI-Vorlagenentwurf

Anbieter ist **Google Gemini** (`@google/genai`), weil sein kostenloses
Kontingent beides mitbringt, was der Entwurf braucht: die Google-Suche als
Werkzeug und eine gegen ein JSON-Schema erzwungene Ausgabe. Ein Betreiber, der
ein paar Mal im Jahr eine Vorlage anlegt, soll dafür keinen kostenpflichtigen
Zugang brauchen.

`GSP_GEMINI_API_KEY` schaltet den Knopf „Vorlage entwerfen lassen" frei —
bewusst eine Umgebungsvariable, nicht die Datenbank, weil sie sonst in jedem
Backup läge. Ohne Schlüssel meldet `GET /api/templates/ki/status` das, und die
Oberfläche blendet den Knopf aus.

`GSP_GEMINI_MODELL` ist konfigurierbar, weil Googles Kennungen sich schneller
ändern als dieses Panel. Wer sie im Code fest verdrahtet, baut einen 404 für
übermorgen ein.

**Die Recherche macht kein Modell.** `services/image-doku.ts` holt die
Beschreibung des Images bei Docker Hub und, wo sie dünn ist, das README des
verlinkten GitHub-Repos. Googles Suchwerkzeug ist im kostenlosen Kontingent
**nicht** enthalten — es antwortet dort mit `RESOURCE_EXHAUSTED`, schon beim
ersten Aufruf.

Der direkte Weg ist ohnehin der bessere: Primärquelle statt Suchtreffer, kein
Kontingent, reproduzierbar. Gemessen: 25.000 Zeichen bei
`lloesche/valheim-server`, 15.000 bei `mornedhels/enshrouded-server`, 8.000 bei
`ryshe/terraria` — jeweils mit den echten Variablennamen. Nur
`itzg/minecraft-server` ist mit 1.400 Zeichen dünn; dort greift das README.

Dem Modell bleibt damit eine Aufgabe: die Dokumentation ins Schema gießen
(`services/vorlagen-ki.ts`).

**Nicht das neueste Modell als Vorgabe.** `gemini-3.8-flash` antwortete im Test
durchgehend mit „high demand" (503), die Generation darunter lief. Deshalb
`gemini-3.7-flash` als Standard, eine Wiederholung bei Überlastung, und
`GSP_GEMINI_MODELL` zum Umschalten.

**Ein Entwurf wird nie automatisch gespeichert.** Er landet im Editor, mit den
Belegen daneben, und durchläuft beim Speichern dieselbe Prüfung wie eine
handgeschriebene Vorlage.

Der Weg braucht einen Schlüssel und ist deshalb in der Entwicklung nicht
durchspielbar. `scripts/entwurf-testen.mjs` erzeugt einen Entwurf auf der
Kommandozeile — ohne Panel, ohne Anmeldung:

```bash
GSP_GEMINI_API_KEY=... node scripts/entwurf-testen.mjs "Terraria" "ryshe/terraria"
```

## Weiterführend

- `README.md` — Betrieb, Einstellungen, Sicherheit
- `docs/architektur.md` — Entscheidungen und ihre Begründung
- `docs/vorlage-hinzufuegen.md` — neues Spiel ergänzen
- `docs/entwicklungsprotokoll.md` — ursprünglicher Plan, Abweichungen, gefundene Fehler
- `docs/erkenntnisse.md` — Lagebild für neue Sitzungen: wo was liegt, wie ein Feature
  durch die Schichten läuft, Eigenheiten dieser Windows-Maschine, offene Punkte
