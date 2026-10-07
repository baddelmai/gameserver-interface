# Gameserver-Panel

Web-Panel zur Verwaltung mehrerer Gameserver-Instanzen auf einem Linux-Host.
Jede Instanz läuft als Docker-Container; das Panel steuert sie, streamt die
Logs, verwaltet Spieler, Backups, Mods und die Serverkonfiguration — und legt
neue Instanzen aus zwanzig mitgelieferten Vorlagen an — von **Minecraft** über
**Counter-Strike 2** und **Rust** bis **Satisfactory**. Weitere kommen ohne
Codeänderung dazu.

## Techstack

| Schicht | Wahl |
| --- | --- |
| Frontend | React 19 · TypeScript · Vite · CSS Custom Properties |
| Backend | Fastify 5 · TypeScript · Node 22 |
| Gemeinsam | Zod-Schemas und Vorlagen in `@gsp/shared` |
| Datenhaltung | SQLite (better-sqlite3) |
| Container | Docker Engine API über dockerode |
| Backups | tar + zstd aus `node:zlib` |
| Tests | Vitest |

## Schnellstart

```bash
cp .env.example .env      # GSP_DATA_DIR und GSP_PUBLIC_HOST anpassen
docker compose up -d --build
```

Panel öffnen unter `http://127.0.0.1:8770`. Beim ersten Aufruf wird das
Administratorkonto angelegt.

### Entwicklung

```bash
npm install
npm run build -w @gsp/shared

# Backend und Frontend parallel, ohne Docker:
GSP_RUNTIME=fake npm run dev
```

`GSP_RUNTIME=fake` ersetzt die Container-Laufzeit durch eine Simulation im
Speicher — Instanzen lassen sich anlegen, starten und stoppen, es entstehen
Logzeilen im echten Format der jeweiligen Spiele. Für die Entwicklung der
Oberfläche wird damit kein Docker-Daemon gebraucht.

```bash
npm test           # Testsuite
npm run typecheck  # Typprüfung über alle Pakete
npm run build      # Produktionsbuild
```

## Was die mitgelieferten Vorlagen können

Der Design-Prototyp nimmt an, dass jede Instanz eine Befehlseingabe und eine
Mod-Liste hat. Real gilt das für die wenigsten Spiele. Die Oberfläche blendet
Bedienelemente entsprechend aus oder deaktiviert sie mit Hinweis.

Der Startbestand deckt gängige Mehrspielerspiele ab; er ist ein Anfang, kein
Rahmen — eigene Vorlagen entstehen im Editor unter „Vorlagen".

| | Image | Konsole schreiben | Spielerliste | Kick / Bann | Mods |
| --- | --- | --- | --- | --- | --- |
| **Minecraft** | `itzg/minecraft-server` | ja, über RCON | Namen per RCON | ja | .jar |
| **Minecraft (Bedrock)** | `itzg/minecraft-bedrock-server` | nein | nur aus dem Log | nein | keine |
| **Valheim** | `lloesche/valheim-server` | nein | Zahl per Steam-Abfrage, Namen aus dem Log | nein | BepInEx (.dll) |
| **Enshrouded** | `mornedhels/enshrouded-server` | nein | nur aus dem Log | nein | keine |
| **Factorio** | `factoriotools/factorio` | nein | nur aus dem Log | nein | .zip |
| **Terraria** | `ryshe/terraria` | nein | nur aus dem Log | nein | .dll |
| **Luanti (Minetest)** | `linuxserver/minetest` | nein | nur aus dem Log | nein | keine |
| **Palworld** | `thijsvanloef/palworld-server-docker` | ja, über RCON | Zahl per Steam-Abfrage, Namen aus dem Log | nein | keine |
| **Counter-Strike 2** | `joedwards32/cs2` | ja, über RCON | Zahl per Steam-Abfrage, Namen aus dem Log | nein | keine |
| **Team Fortress 2** | `cm2network/tf2` | ja, über RCON | Zahl per Steam-Abfrage, Namen aus dem Log | nein | keine |
| **Garry's Mod** | `hackebein/garrysmod` | nein | Zahl per Steam-Abfrage, Namen aus dem Log | nein | keine |
| **Rust** | `didstopia/rust-server` | nein | Zahl per Steam-Abfrage, Namen aus dem Log | nein | .cs |
| **ARK: Survival Evolved** | `hermsi/ark-server` | ja, über RCON | Zahl per Steam-Abfrage, Namen aus dem Log | nein | keine |
| **7 Days to Die** | `vinanrra/7dtd-server` | nein | Zahl per Steam-Abfrage, Namen aus dem Log | nein | BepInEx (.dll) |
| **Project Zomboid** | `renegademaster/zomboid-dedicated-server` | ja, über RCON | nur aus dem Log | nein | keine |
| **V Rising** | `trueosiris/vrising` | ja, über RCON | Zahl per Steam-Abfrage, Namen aus dem Log | nein | keine |
| **Satisfactory** | `wolveix/satisfactory-server` | nein | nur aus dem Log | nein | keine |
| **Don't Starve Together** | `jamesits/dst-server` | nein | nur aus dem Log | nein | keine |
| **Core Keeper** | `escaping/core-keeper-dedicated` | nein | nur aus dem Log | nein | keine |
| **Barotrauma** | `goldfish92/barotrauma-dedicated-server` | nein | Zahl per Steam-Abfrage, Namen aus dem Log | nein | .sub |

Hintergrund:

- **Valheim** kennt weder RCON noch stdin-Befehle — Admin-Befehle gibt es nur
  in der Spielkonsole (F5). Die Panel-Konsole zeigt deshalb nur den Log-Stream.
  Beim Verlassen protokolliert Valheim keinen Namen; die Liste wird gegen die
  Steam-Abfrage abgeglichen.
- **Enshrouded** hat kein natives Linux-Binary und läuft unter Wine. Der Zugang
  erfolgt über **Server-Rollen** (Admin, Freund, Gast) mit je eigenem Passwort;
  ein einzelnes Serverpasswort kennt das Spiel nicht mehr. Es gibt nur noch
  einen Port (15637/udp).
- **Kick und Bann** hängen an einer einzigen Fähigkeit, und das Panel führt nur
  Namen. Spiele, die für den Bann eine Steam-Kennung verlangen — Palworld,
  Counter-Strike 2, ARK —, sagen sie deshalb nicht zu; über die Konsole geht
  beides trotzdem.
- Ein **Ping je Spieler** liefert keines dieser Serverprotokolle; er wird als
  `—` angezeigt. Der Ping im Detailkopf ist die Antwortzeit der Serverabfrage.
- Die **Spielzeit** führt das Panel selbst — kein Spiel liefert sie.
- Ob für eine Mod eine **neuere Version** vorliegt, kann das Panel nicht
  feststellen; es ist keine Mod-Quelle angebunden.

## Aufbau

```
packages/
  shared/   Zod-Schemas, Typen, Vorlagen-Definitionen, Formatierung
  server/   Fastify: Auth, Runtime, Spiel-Adapter, Dienste, REST, WebSocket
  web/      React-Oberfläche nach dem v2-Design
```

Eine Vorlage (`packages/shared/src/templates/`) beschreibt deklarativ Image,
Ports, Volumes, Formularfelder, Env-Abbildung, Fähigkeiten, Log-Muster und
Backup-Pfade. Daraus entstehen der Anlege-Wizard, der Config-Reiter und der
Container — eine neue Vorlage braucht also nur eine Datei.

Die Container-Laufzeit liegt hinter der Schnittstelle `Runtime`
(`packages/server/src/runtime/`). `DockerRuntime` spricht die Engine-API,
`FakeRuntime` simuliert sie; ein systemd-Adapter ließe sich daneben stellen.

Instanz-Volumes sind Bind-Mounts unterhalb von `GSP_DATA_DIR/instances/<id>`.
Backups und Mod-Verwaltung arbeiten dadurch direkt auf Host-Pfaden.

Vorlagen liegen als Daten in der Datenbank und lassen sich im Panel unter
„Vorlagen" bearbeiten oder neu anlegen — ein weiteres Spiel braucht keinen
Eingriff in den Code. Ist `GSP_GEMINI_API_KEY` gesetzt, kann Google Gemini einen
Entwurf vorschlagen: das Panel holt die Dokumentation des Images bei Docker Hub
(und, wo nötig, das README des verlinkten Repos), Gemini gießt sie in die
Vorlage. Gespeichert wird nichts automatisch — der Entwurf landet mit seinen
Belegen im Editor. Siehe `docs/vorlage-hinzufuegen.md`.

Den Schlüssel gibt es kostenlos im [Google AI Studio](https://aistudio.google.com/apikey),
ohne Kreditkarte. Statt Kosten gelten Mengengrenzen — für gelegentliche Entwürfe
reichlich bemessen (10 Anfragen pro Minute, 1.500 pro Tag, 5.000 Suchen im Monat).

## Einstellungen

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `GSP_PORT` | `8770` | Port des Panels |
| `GSP_HOST` | `0.0.0.0` | Bind-Adresse |
| `GSP_DATA_DIR` | `./data` | Datenbank, Instanz-Volumes, Backups |
| `GSP_HOST_DATA_DIR` | wie `GSP_DATA_DIR` | Pfad der Daten **aus Sicht des Docker-Hosts** — nötig, wenn das Panel selbst im Container läuft |
| `GSP_RUNTIME` | `docker` | `docker` oder `fake` |
| `GSP_DOCKER_SOCKET` | `/var/run/docker.sock` | Socket der Engine |
| `GSP_PUBLIC_HOST` | Hostname | Adresse, unter der Spieler die Server erreichen |
| `GSP_NODE_LABEL` | `node 01` | Beschriftung in der Kopfzeile |
| `GSP_REFRESH_MS` | `2000` | Takt der Live-Messwerte |
| `GSP_SECURE_COOKIES` | `false` | Sitzungscookie nur über HTTPS senden |
| `GSP_SESSION_TTL_HOURS` | `336` | Gültigkeit einer Sitzung |
| `GSP_WEB_ROOT` | — | Verzeichnis des gebauten Frontends |
| `GSP_TEMP_DIR` | `GSP_DATA_DIR/tmp` | Zwischenablage für Welt-Uploads. Sollte auf demselben Dateisystem liegen wie die Instanz-Volumes — sonst wird das Einspielen ein Kopiervorgang statt eines Verschiebens. Der Inhalt überlebt keinen Neustart. |
| `GSP_WORLD_UPLOAD_MAX_MB` | `4096` | Obergrenze für eine hochgeladene Welt. Das Limit für Mods (256 MB) bleibt davon unberührt. |
| `GSP_GEMINI_API_KEY` | — | Schlüssel für den KI-Vorlagenentwurf ([kostenlos](https://aistudio.google.com/apikey)). Ohne ihn bleibt der Knopf ausgeblendet. |
| `GSP_GEMINI_MODELL` | `gemini-3.7-flash` | Modell für den Entwurf. Bewusst nicht das neueste — das ist meist überlastet. Bei „Modell nicht verfügbar" hier eine aktuelle Kennung eintragen. |
| `TZ` | `Europe/Berlin` | Zeitzone für Instanzen und Zeitpläne |

`GSP_DATA_DIR` muss ein Pfad sein, den der **Docker-Daemon** auflösen kann, denn
er dient sowohl als Bind-Quelle im Compose-File als auch als `GSP_HOST_DATA_DIR`
für die Instanz-Volumes.

Unter **Docker Desktop für Windows** läuft der Daemon in einer Linux-VM. Ein
Windows-Pfad wie `D:\ServerTest` ist dort kein absoluter Pfad; `path.resolve()`
im Panel-Container macht daraus `/app/D:ServerTest`, und die Instanzen mounten
ins Leere. Laufwerke hängen in der VM unter `/run/desktop/mnt/host/<laufwerk>/`,
Buchstabe klein geschrieben:

```dotenv
GSP_DATA_DIR=/run/desktop/mnt/host/d/ServerTest
```

Prüfen lässt sich das ohne das Panel:

```bash
docker run --rm -v /run/desktop/mnt/host/d/ServerTest:/probe alpine ls -la /probe
```

## Sicherheit

**Der eingebundene Docker-Socket entspricht Root-Rechten auf dem Host.** Wer
das Panel bedienen kann, kann darüber beliebige Container starten. Daraus
folgt:

- Das Panel **nicht ohne TLS und Reverse-Proxy** öffentlich erreichbar machen.
  Die Compose-Datei veröffentlicht den Port bewusst nur auf `127.0.0.1`.
- Hinter TLS `GSP_SECURE_COOKIES=true` setzen.
- Ein starkes Administratorpasswort wählen (mindestens 12 Zeichen).

Weiter umgesetzt:

- Passwörter mit scrypt gehasht (`node:crypto`, ohne native Abhängigkeit).
- Sitzungscookie `httpOnly` und `SameSite=Lax`; jede schreibende Anfrage
  braucht zusätzlich einen CSRF-Token aus der Sitzung.
- Rate-Limit auf die Anmeldung.
- Container werden ausschließlich über die dockerode-API gebaut — Nutzereingaben
  landen nie in einer Shell.
- RCON-Passwörter werden erzeugt, nur intern verwendet und nie ausgeliefert;
  Passwortfelder erscheinen in der API maskiert.
- Backup-Wiederherstellung und Mod-Upload prüfen, dass der Zielpfad innerhalb
  des Instanz-Volumes liegt.
- Abgesetzte Konsolenbefehle werden mit Benutzer protokolliert.

## Backups

Gesichert werden die in der Vorlage benannten Weltverzeichnisse als
`<instanz>-<JJJJ-MM-TT-hhmm>-<auto|manuell>.tar.zst`. Bei Minecraft hält das
Panel vorher über RCON die Schreibvorgänge an (`save-off`, `save-all flush`)
und gibt sie danach wieder frei — auch wenn das Sichern fehlschlägt.

Automatische Backups laufen nach dem Cron-Ausdruck der Instanz; die
Aufbewahrungsfrist entfernt nur automatische Snapshots, manuelle bleiben
erhalten. Eine Wiederherstellung stoppt die Instanz, ersetzt die Weltdaten und
startet sie danach wieder.

## Dokumentation

- `CLAUDE.md` — Einstieg für KI-Agenten: Befehle, Architektur, Fallstricke
- `docs/architektur.md` — Entscheidungen und ihre Begründung
- `docs/vorlage-hinzufuegen.md` — ein weiteres Spiel ergänzen
- `docs/entwicklungsprotokoll.md` — Vorgehen, gefundene Fehler, Prüfvorgehen

## Grenzen und mögliche Erweiterungen

- Nur ein Benutzer mit vollen Rechten; Rollen sind nicht umgesetzt.
- Ein Host je Panel — die Kopfzeile ist auf mehrere Knoten vorbereitet.
- Mod-Aktualisierungen werden nicht gegen Modrinth oder Thunderstore geprüft.
- Neben `DockerRuntime` ist ein systemd-Adapter vorgesehen, aber nicht gebaut.
