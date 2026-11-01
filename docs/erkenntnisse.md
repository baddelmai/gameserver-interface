# Erkenntnisse für neue Sitzungen

Lagebild der Codebasis, Stand 01.11.2026 (v0.4.0).
Ergänzt `CLAUDE.md`, ohne es zu wiederholen: dort stehen Befehle, Architektur und
Fallstricke, hier das, was man beim Einarbeiten erst zusammensuchen muss.

## Orientierung in fünf Minuten

| Wenn du … | dann lies zuerst |
| --- | --- |
| eine Vorlage ändern oder ein Spiel ergänzen willst | `packages/shared/src/schema/template-definition.ts`, eine Vorlage in `packages/shared/src/templates/`, `docs/vorlage-hinzufuegen.md` |
| an Start, Stopp und Status arbeitest | `packages/server/src/services/instances.ts` (zentral, ~700 Zeilen) |
| eine neue Instanzfunktion mit Dateien baust | `services/world.ts` und `services/files.ts` als Muster |
| eine API-Route ergänzt | `routes/instances.ts`, Fehlerabbildung in `app.ts` (`setErrorHandler`) |
| die Oberfläche anfasst | `packages/web/src/App.tsx` (hält fast allen Zustand), dann den Reiter in `tabs/` |
| Vorlagen-Schlüssigkeit prüfen willst | `TemplateService.validate…` in `services/templates.ts` |

Rund 20.000 Zeilen, davon die Hälfte Server. Es gibt 20 mitgelieferte Vorlagen
(`BUILTIN_DEFINITIONS` in `packages/shared/src/templates/index.ts`).

## Wie ein Feature durch die Schichten läuft

Jede Instanzfunktion (Welt, Mods, Backups, jetzt Dateien) hat denselben Weg:

1. **Schema** in `packages/shared/src/schema/*.ts`, exportiert über
   `packages/shared/src/index.ts`. Danach `npm run build -w @gsp/shared`, sonst
   sehen Server und Web die alten Typen.
2. **Dienst** in `packages/server/src/services/`. Er bekommt den `volumeDir` oder
   die `Config` im Konstruktor und arbeitet auf `InstanceRecord`s.
3. **Instanziierung** in `app.ts` (`buildApp`) und Übergabe an
   `instanceRoutes(…, deps)`. Das `Deps`-Interface in `routes/instances.ts`
   muss mitwachsen.
4. **Route** in `routes/instances.ts`. Sie ist dünn: `need(id)` holt die Instanz
   (404 über `ValidationError('Instanz nicht gefunden')`), Zod prüft den Körper,
   der Dienst arbeitet. Eigene Fehlerklassen mit Statuscode fängt die Route selbst
   ab (`WorldError`, `FileError`); was durchfällt, wird zu 500.
5. **API-Client** in `packages/web/src/api/client.ts`. Er liest jede Antwort als
   JSON, deshalb laufen Downloads als bloße URL (`worldDownloadUrl`).
6. **Reiter** in `packages/web/src/tabs/`, verdrahtet in `App.tsx`. Reiter, die
   nur unter einer Bedingung erscheinen, filtert `visibleTabs()` in
   `components/Tabs.tsx`.
7. **Tests**: Dienst mit echten Dateien in `services/*.test.ts` (Muster:
   `world.test.ts`, `files.test.ts`), API-Durchlauf in `app.test.ts` gegen die
   Fake-Laufzeit. Oberfläche per Playwright-Skript im Repo-Wurzelverzeichnis
   (`pw-*.mjs`).

Ereignisse fürs Protokoll der Instanz laufen über `InstanceService.announce()`
(öffentlich) bzw. `event()` (privat). Sie landen in der Tabelle `events`, im Log
und per WebSocket in der Übersicht.

## Mitgelieferte Vorlagen ändern

**Seeding überschreibt nie.** Eine geänderte Vorlage im Code erreicht bestehende
Installationen deshalb nicht von selbst. Dafür gibt es gezielte Migrationen in
`TemplateService.seedAndLoad()`: `backfillWorld()`,
`migrateValheimWorldFormat()`, `migrateEnshroudedRolePermissions()`,
`migrateEnshroudedRoleRules()`. Die Regeln dahinter:

- Nur Zeilen mit `builtin = 1` anfassen, und nur, wenn der alte Stand eindeutig
  erkennbar ist.
- `updated_at` **nur** neu setzen, wenn sich der Container ändert. Ein neuer
  Zeitstempel lässt alle Instanzen „Vorlage geändert" melden
  (`templateStale`).
- Ein neues Feld im Descriptor muss in `toDescriptor()` ausdrücklich
  aufgezählt werden.

## Eigenheiten des Codes

- **Benennung im Web-Paket ist noch gemischt.** `CLAUDE.md` verlangt englische
  Bezeichner. Im Frontend stehen aber noch viele deutsche Reste (`Wert`,
  `gesperrt`, `onJa`, `onUmschalten`, `setInstanzen`, `setWeltSicherung`). Neuen
  Code englisch schreiben, Bestehendes nur im Zuge echter Änderungen umbenennen.
- `CLAUDE.md` nennt `services/vorlagen-ki.ts`, die Datei heißt inzwischen
  `services/template-ai.ts` (Dokumentation von `image-docs.ts` ebenso, dort noch
  `image-doku.ts`).
- Keine Komponentenbibliothek, keine Router-Bibliothek, kein globaler Store.
  `App.tsx` lädt reiterabhängige Daten in einem `useEffect` auf `[tab, instance?.id]`.
- Farben nur über die Tokens in `styles/tokens.css`. Literalfarben stehen nur
  bei den Fehlerflächen (`rgba(255,107,107,…)`) und sind dort begründet.
- `.sectionlabel`, `.button` und `.tab__label` setzen per CSS in Großbuchstaben.
  Playwright liest mit `innerText()` deshalb `UNGESPEICHERT`, nicht
  `ungespeichert`. Und für Dateipfade taugt `SectionLabel` nicht, weil Linux
  zwischen Groß- und Kleinschreibung unterscheidet.
- Das HTML-Attribut `hidden` wird von Klassen mit eigener `display`-Regel
  überstimmt (siehe Kommentar in `App.tsx`). Für Wrapper ohne Klasse funktioniert
  es.

## Diese Maschine (Windows 11, Docker Desktop)

- **`paths.test.ts` schlägt unter Windows mit 3 Tests fehl.** Die Erwartungen
  sind POSIX-Pfade (`/srv/gsp/…`), `path.join` liefert hier `C:\srv\gsp\…`. Das
  ist ein Testproblem und keine Regression. Unter Linux und im Image ist es
  grün. Wer das behebt: die Erwartungen mit `join()`/`resolve()` bilden.
- Die Arbeitskopie hat CRLF-Zeilenenden (Git-`autocrlf`). Neue Dateien mit LF
  sind unproblematisch, Git gleicht beim Einchecken an.
- Port 8770 belegt der laufende Panel-Container. Testserver auf einem anderen
  Port starten:

  ```bash
  npm run build
  GSP_RUNTIME=fake GSP_PORT=8793 GSP_HOST=127.0.0.1 GSP_LOG_LEVEL=warn \
    GSP_DATA_DIR=<scratch>/gsp-data GSP_WEB_ROOT=$PWD/packages/web/dist \
    node packages/server/dist/index.js
  ```

- Playwright läuft hier mit dem regulären `chromium.launch()`. Der
  `executablePath` aus `CLAUDE.md` gilt nur für die ursprüngliche Linux-Sandbox.
- Die Ersteinrichtung lässt sich im Skript per
  `page.request.post('/api/auth/setup', …)` erledigen. Das Cookie landet im
  Browserkontext, `page.goto()` zeigt danach direkt das Panel.
- Echte Docker-Container sind hier prüfbar, entgegen `CLAUDE.md` (siehe
  Auto-Memory). Nie vom Host in `panel.db` schreiben, solange der Container läuft.

## Feature: Konfigurationsdateien direkt bearbeiten

Seit diesem Zweig hat der Config-Reiter einen Umschalter **Formular | Dateien**.
„Dateien" zeigt die Volumes der Instanz als Verzeichnisbaum und bearbeitet
Textdateien in einem Editor mit Zeilennummern.

| Schicht | Datei |
| --- | --- |
| Schema, Grenzwerte, Endungsliste | `packages/shared/src/schema/files.ts` |
| Dienst | `packages/server/src/services/files.ts` |
| Routen | `GET /api/instances/:id/files?volume=&path=`, `GET …/files/content?volume=&path=`, `PUT …/files/content` in `routes/instances.ts` |
| Oberfläche | `packages/web/src/tabs/ConfigFiles.tsx`, Umschalter in `tabs/Config.tsx`, Styles `.files*` und `.editor*` in `styles/tabs.css` |
| Tests | `services/files.test.ts` (13), Block „Konfigurationsdateien" in `app.test.ts`, `pw-config-dateien.mjs` |

### Entscheidungen

- **Generisch statt je Vorlage.** Der Editor braucht keine Angabe in der Vorlage
  und funktioniert damit sofort für alle 20 mitgelieferten und alle eigenen
  Vorlagen. Adressiert wird über *Volume-Name + relativer Pfad*, nie über
  Container- oder Host-Pfade.
- **Nur Lesen und Überschreiben.** Kein Anlegen, Umbenennen oder Löschen. Eine
  fehlende Datei legt der Server beim ersten Start selbst an.
- **Symbolische Verweise.** Prozesse im Container können Verweise auf
  `/etc/shadow` anlegen, und das Panel auf dem Host folgte ihnen. Deshalb wird
  jeder Pfad mit `realpath()` aufgelöst und gegen das ebenfalls aufgelöste Volume
  geprüft. `..` und Laufwerksbuchstaben werden abgelehnt, nicht aufgelöst.
  Verweise nach außen erscheinen nicht einmal in der Liste.
- **Optimistische Sperre.** `read` liefert `rev` (SHA-256 des Inhalts), `write`
  verlangt ihn zurück und antwortet bei Abweichung mit 409. Grund: Viele Server
  schreiben ihre Konfiguration beim Beenden zurück. Die Oberfläche bietet dann
  „Neu laden" an.
- **Kodierung bleibt erhalten.** Nur UTF-8 (`TextDecoder` mit `fatal: true`).
  Latin-1 und Binärdaten antworten mit 415, statt Umlaute beim Speichern zu
  zerstören. BOM und CRLF werden beim Lesen entfernt und beim Speichern wieder
  angebracht; die Textarea liefert immer `\n`.
- **JSON wird vor dem Speichern geprüft** (400 mit Fehlerposition). Mit
  `force: true` lässt sich das übergehen, in der Oberfläche über „Trotzdem
  speichern".
- **Atomar schreiben, Eigentümer erhalten.** Der Inhalt geht in eine Arbeitsdatei
  `.gsp-edit-*` daneben, bekommt Modus und uid/gid des Originals und ersetzt es
  dann per `rename`. Ohne das gehörte die Datei danach root, und ein Server mit
  uid 1000 könnte sie nicht mehr schreiben. `chown` scheitert ohne root still.
  `.gsp-*`-Dateien blendet die Liste aus.
- **Grenzen:** 1 MiB je Datei, 1000 Einträge je Verzeichnis. Die Liste zeigt
  vorab nur Konfigurationsendungen (`CONFIG_EXTENSIONS`), „weitere Dateien
  zeigen" blendet den Rest ein. Enshrouded und Valheim haben den ganzen Server im
  Volume.
- **Neustart statt Neuaufbau.** „Speichern & neu starten" ruft
  `instances.restart()`, nicht `recreate()`: Dateien wirken ohne neuen Container.
- **Keine Editor-Bibliothek.** Eine Textarea mit Zeilennummern, Strg+S speichert.
  Tab bleibt Fokuswechsel (Tastaturfalle vermeiden). CodeMirror wäre der nächste
  Schritt, falls Syntaxhervorhebung gewünscht ist.
- Jede Bearbeitung steht im Server-Log mit Benutzer und als Ereignis
  „`<pfad>` von Hand bearbeitet" bei der Instanz.

### Bekannte Grenzen und offene Punkte

- **Env-Überschreibung.** Viele Images schreiben ihre Konfiguration bei jedem
  Start aus der Umgebung neu (bekannt von `itzg/minecraft-server` für
  `server.properties`; bei `mornedhels/enshrouded-server` für die
  `SERVER_*`-Schlüssel der `enshrouded_server.json` naheliegend, **nicht
  geprüft**). Die Oberfläche sagt das allgemein. Pro Vorlage zu wissen, welche
  Schlüssel überschrieben werden, wäre der nächste Ausbau: ein optionaler Block
  `configFiles: [{ path, note }]` in der Vorlagendefinition, der bekannte
  Dateien hervorhebt und kommentiert. Er bräuchte eine Backfill-Migration wie
  `backfillWorld()`, und jeder Eintrag gehört belegt, nicht geraten.
- Gegen echte Container ungeprüft: Rechte und Eigentümer nach dem Speichern
  (uid 1000 im Spielcontainer, Panel als root) und das Verhalten unter Docker
  Desktop mit virtiofs-Mounts.
- Ungespeicherte Änderungen überleben den Wechsel zwischen Formular und Dateien
  (beide bleiben eingehängt), **nicht** aber einen Reiterwechsel. Beim
  Dateiwechsel fragt der Editor nach.
- Zeilenenden werden vereinheitlicht (die Mehrheit entscheidet). Eine Datei mit
  bewusst gemischten Enden verliert diese Mischung.

## Minecraft Bedrock über NetherNet

Mit BDS 26.50 wurde NetherNet die Vorgabe. Seit Client 26.60 verbinden sich
Spieler nicht mehr über RakNet, und die alte Vorlage (nur UDP 19132) war damit
unerreichbar. Die Java-Vorlage ist nicht betroffen.

| | vorher (RakNet) | jetzt (NetherNet) |
| --- | --- | --- |
| Verbindungsaufbau | UDP 19132 | **TCP** 19132 (Port `game`) |
| Spieldaten | derselbe Port | **UDP-Bereich**, ein Port je Spieler (Port `udp`, 20 ab 19140) |
| `SERVER_PORT` | Host-Port (fehlerhaft, sobald ≠ 19132) | fest `19132`, der Container-Port |
| neu | | `TRANSPORT=nethernet`, `SERVER_UDP_PORTS=<Adresse>:<Host-Bereich>:<Container-Bereich>` |
| neues Feld | | `publicAddress` „Erreichbar unter", Vorgabe `<public_ip>` |

Dafür kamen zwei allgemeine Bausteine dazu:

- **`PortSpec.count`**: Ein Port-Eintrag kann einen Bereich beschreiben.
  Docker bekommt ihn als einzelne Bindungen (`portBindings()` in
  `runtime/docker.ts`). Kollisionsprüfung und Portvorschlag in
  `services/instances.ts` rechnen mit dem ganzen Bereich.
- **Env-Quelle `portMapping`**: Sie baut `[Adresse:]Host:Container`, bei
  Bereichen `a-b:c-d`. Die Adresse kommt aus einem Feld.

**Bestehende Installationen:** `migrateBedrockNetherNet()` stellt die
*mitgelieferte* Bedrock-Zeile beim Start um und setzt `updated_at` neu. Die
Instanzen melden dann „Vorlage geändert". Beim „Neu aufbauen" trägt
`InstanceService.completePorts()` den fehlenden UDP-Bereich frei nach;
vorhandene Ports bleiben unverändert. Eigene Kopien der Vorlage werden nicht
angefasst und müssen im Editor nachgezogen werden.

Ungeprüft gegen einen echten Client: der Verbindungsaufbau über NetherNet
selbst, `<public_ip>` hinter NAT (Router braucht Hairpin-NAT, wenn Spieler im
eigenen Netz die öffentliche IP nutzen), und ob BDS 26.x die Log-Zeilen
`Player connected:` und `Server started.` noch genauso schreibt.

## Weltarchive und Backups von außen

- **`world.archives`** (optional) nennt Endungen, die wie ein ZIP entpackt
  werden. Das Gegenstück dazu ist `world.accept`, dessen Dateien roh als Welt
  übernommen werden. Bedrock führt `.mcworld`;
  `migrateBedrockMcworld()` ergänzt das bei bestehenden Installationen, ohne
  `updated_at` zu ändern.
- **Backup-Download:** `GET /api/instances/:id/backups/:backupId/download`
  streamt das Archiv, wie beim Welt-Download.
- **Backup-Upload:** `POST /api/instances/:id/backups/upload`
  (`BackupService.importUpload()`) liest das Archiv vor der Übernahme
  vollständig. Jeder Eintrag muss unter einem `backup.paths`-Pfad der Vorlage
  liegen, relativ zur Instanzwurzel. Verweise, `..` und absolute Pfade werden
  abgelehnt. Der Upload spielt nichts ein, sondern legt nur einen Snapshot
  an; eingespielt wird mit „Restore“.
- Die Backup-Liste im Frontend lädt neu, sobald ein Backup-Job fertig ist
  (`backupsDone` in `App.tsx`). Vorher wurde sie geladen, bevor das Archiv
  existierte.
