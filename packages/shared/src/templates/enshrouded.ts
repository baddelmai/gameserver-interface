import type { TemplateDefinition } from '../schema/template-definition.js';

/**
 * Enshrouded auf Basis von `mornedhels/enshrouded-server`.
 *
 * Enshrouded hat kein natives Linux-Binary — der Windows-Server läuft im Image
 * unter Wine. Es gibt weder RCON noch eine stdin-Konsole, und Mods unterstützt
 * das Spiel nicht.
 *
 * Zwei Besonderheiten gegenüber den anderen Vorlagen:
 * - Der Zugang läuft über **Server-Rollen** (Admin/Friend/Guest) mit je eigenem
 *   Passwort. Ein einzelnes `SERVER_PASSWORD` ist im Spiel abgekündigt und wird
 *   ignoriert.
 * - Es gibt nur noch **einen** Port (Query-Port 15637/udp); die früher übliche
 *   Trennung in Spiel- und Query-Port ist entfallen.
 *
 * Alle mit `SERVER_` beginnenden Variablen des Images bilden die Optionen der
 * `enshrouded_server.json` ab.
 */
export const enshroudedDefinition: TemplateDefinition = {
  id: 'enshrouded',
  label: 'Enshrouded',
  summary: 'Dedizierter Enshrouded-Server unter Wine. Zugang über Server-Rollen, Konsole nur lesend, keine Mods.',
  image: 'mornedhels/enshrouded-server',
  defaultTag: 'latest',
  defaultMemoryMb: 16384,
  defaultCpus: 6,
  notes: [
    'Enshrouded läuft unter Wine — der erste Start dauert deutlich länger, weil SteamCMD lädt und das Wine-Präfix angelegt wird.',
    'Das Spiel bietet weder RCON noch Mod-Unterstützung: Die Konsole ist read-only, der Mod-Reiter entfällt.',
    'Der Zugang läuft über Rollenpasswörter (Admin, Freund, Gast) — ein einzelnes Serverpasswort kennt Enshrouded nicht mehr.',
    'Jede Rolle braucht ein eigenes Passwort; nur der Gast darf offen bleiben. Sonst verweigert Enshrouded den Start.',
    'Spielernamen werden aus dem Log gelesen; einen Ping liefert der Server nicht.',
  ],
  capabilities: {
    console: 'readonly',
    players: 'log',
    mods: 'none',
    moderation: false,
  },
  ports: [
    { name: 'query', label: 'Spiel-/Query-Port', container: 15637, protocol: 'udp', defaultHost: 15637, internalOnly: false },
  ],
  volumes: [{ name: 'data', containerPath: '/opt/enshrouded', role: 'data' }],
  fields: [
    {
      id: 'serverName', label: 'Servername', type: 'text', default: 'Enshrouded Server',
      required: true, maxLength: 48, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'adminPassword', label: 'Admin-Passwort', type: 'password', default: '',
      required: true, maxLength: 32, editable: true, restartRequired: true, secret: true,
      help: 'Rolle „Admin“ — volle Rechte inklusive Kick und Bann im Spiel.',
    },
    {
      id: 'friendPassword', label: 'Freund-Passwort', type: 'password', default: '',
      required: true, maxLength: 32, editable: true, restartRequired: true, secret: true,
      help: 'Rolle „Friend“ — darf bauen und Inventare nutzen. Pflicht: Enshrouded erlaubt nur eine Rolle ohne Passwort, und das ist der Gast.',
    },
    {
      id: 'guestPassword', label: 'Gast-Passwort', type: 'password', default: '',
      required: false, maxLength: 32, editable: true, restartRequired: true, secret: true,
      help: 'Rolle „Guest“ — eingeschränkte Rechte. Leer gelassen kann jeder ohne Passwort als Gast beitreten.',
    },
    {
      id: 'slotCount', label: 'Slots', type: 'number', default: 16,
      min: 1, max: 16, required: true, editable: true, restartRequired: true, secret: false,
      help: 'Enshrouded erlaubt höchstens 16 Spieler.',
    },
    {
      id: 'gameSettingsPreset', label: 'Spielmodus', type: 'select', default: 'Default',
      options: [
        { value: 'Default', label: 'Standard' },
        { value: 'Relaxed', label: 'Entspannt' },
        { value: 'Hard', label: 'Schwer' },
        { value: 'Survival', label: 'Survival' },
        { value: 'Custom', label: 'Eigene Einstellungen' },
      ],
      required: true, editable: true, restartRequired: true, secret: false,
      help: 'Feinjustierung einzelner Werte erfolgt bei „Eigene Einstellungen“ direkt in der enshrouded_server.json.',
    },
    {
      id: 'voiceChat', label: 'Sprachchat', type: 'boolean', default: false,
      required: false, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'textChat', label: 'Textchat', type: 'boolean', default: true,
      required: false, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'updateCron', label: 'Update-Zeitplan', type: 'text', default: '0 5 * * *',
      required: false, maxLength: 40, editable: true, restartRequired: true, secret: false,
      help: 'Cron-Ausdruck für die automatische Spiel-Aktualisierung. Leer = aus.',
    },
  ],

  env: [
    { name: 'SERVER_NAME', source: { kind: 'field', field: 'serverName' }, fallback: 'Enshrouded Server', trim: false, omitWhenEmpty: false },
    { name: 'SERVER_SLOT_COUNT', source: { kind: 'field', field: 'slotCount' }, fallback: '16', trim: false, omitWhenEmpty: false },
    { name: 'SERVER_IP', source: { kind: 'const', value: '0.0.0.0' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_QUERYPORT', source: { kind: 'port', port: 'query' }, fallback: '15637', trim: false, omitWhenEmpty: false },
    { name: 'SERVER_SAVE_DIR', source: { kind: 'const', value: './savegame' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_LOG_DIR', source: { kind: 'const', value: './logs' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_GAMESETTINGSPRESET', source: { kind: 'field', field: 'gameSettingsPreset' }, fallback: 'Default', trim: false, omitWhenEmpty: false },
    {
      name: 'SERVER_ENABLE_VOICE_CHAT', source: { kind: 'field', field: 'voiceChat' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'false', trim: false, omitWhenEmpty: false,
    },
    {
      name: 'SERVER_ENABLE_TEXT_CHAT', source: { kind: 'field', field: 'textChat' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'true', trim: false, omitWhenEmpty: false,
    },
    // Rollen statt eines Serverpassworts — Reihenfolge entspricht den Standardgruppen.
    { name: 'SERVER_ROLE_0_NAME', source: { kind: 'const', value: 'Admin' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_1_NAME', source: { kind: 'const', value: 'Friend' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_2_NAME', source: { kind: 'const', value: 'Guest' }, trim: false, omitWhenEmpty: false },
    // Rechte je Rolle. Ohne diese Variablen legt das Image jede Gruppe ohne
    // Rechte an — das Admin-Passwort griffe dann, brächte aber nichts.
    { name: 'SERVER_ROLE_0_CAN_KICK_BAN', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_0_CAN_ACCESS_INVENTORIES', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_0_CAN_EDIT_WORLD', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_0_CAN_EDIT_BASE', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_0_CAN_EXTEND_BASE', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_1_CAN_KICK_BAN', source: { kind: 'const', value: 'false' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_1_CAN_ACCESS_INVENTORIES', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_1_CAN_EDIT_WORLD', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_1_CAN_EDIT_BASE', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_1_CAN_EXTEND_BASE', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_2_CAN_KICK_BAN', source: { kind: 'const', value: 'false' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_2_CAN_ACCESS_INVENTORIES', source: { kind: 'const', value: 'false' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_2_CAN_EDIT_WORLD', source: { kind: 'const', value: 'true' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_2_CAN_EDIT_BASE', source: { kind: 'const', value: 'false' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_ROLE_2_CAN_EXTEND_BASE', source: { kind: 'const', value: 'false' }, trim: false, omitWhenEmpty: false },
    // Backups und Neustarts steuert das Panel, nicht das Image.
    { name: 'UPDATE_CRON', source: { kind: 'field', field: 'updateCron' }, fallback: '', trim: false, omitWhenEmpty: false },
    { name: 'TZ', source: { kind: 'timezone' }, trim: false, omitWhenEmpty: false },
    // Leeres Rollenpasswort öffnet die Rolle für jeden — die Variable bleibt
    // dann weg, und das Image legt die Gruppe ohne Passwort an.
    { name: 'SERVER_ROLE_0_PASSWORD', source: { kind: 'field', field: 'adminPassword' }, trim: false, omitWhenEmpty: true },
    { name: 'SERVER_ROLE_1_PASSWORD', source: { kind: 'field', field: 'friendPassword' }, trim: false, omitWhenEmpty: true },
    { name: 'SERVER_ROLE_2_PASSWORD', source: { kind: 'field', field: 'guestPassword' }, trim: false, omitWhenEmpty: true },
  ],

  logPatterns: {
    // Abgelesen am Log eines laufenden `mornedhels/enshrouded-server`, zuletzt
    // am 21.10.2026 unter Enshrouded 1.0 mit echtem Beitritt bestätigt:
    //   [server] Player 'Henner' logged in with Permissions:
    //   [server] Remove Player 'Henner'
    //   [game_server] Switching state from LoadEcsScene to Run after 500.23 ms
    // Das Präfix `[server]` gehört zum Muster: ohne es fängt das
    // Beitrittsmuster auch „[server] Machine '1': Player '0(0)' logged in“ —
    // dieselbe Anmeldung, aber mit der internen Nummer statt des Namens.
    join: { source: '\\[server\\] Player \'([^\']+)\' logged in', flags: '' },
    leave: { source: '\\[server\\] Remove Player \'([^\']+)\'', flags: '' },
    // Erst der Zustand `Run` heißt spielbar. `HostOnline` meldet sich früher,
    // da lädt der Server die Welt noch — bei großen Welten Minuten davor.
    ready: { source: '\\[game_server\\] Switching state from \\S+ to Run\\b', flags: '' },
    clean: {
      pattern: { source: '^\\s*\\[?\\d{4}-\\d{2}-\\d{2}[ T][\\d:.]+\\]?\\s*', flags: '' },
      replacement: '',
    },
  },

  validations: [
    {
      rule: 'required',
      field: 'adminPassword',
      message: 'Ohne Admin-Passwort ist der Server nicht administrierbar',
    },
    // Enshrouded 1.0 verweigert sonst den Start („Only one user group can be
    // without password“, „user groups passwords must be unique“) und das Image
    // startet ihn endlos neu — die Instanz stünde für immer auf „Startet“.
    // Offen bleiben darf nur der Gast.
    {
      rule: 'required',
      field: 'friendPassword',
      message: 'Nur der Gast darf ohne Passwort bleiben — Enshrouded startet sonst nicht',
    },
    {
      rule: 'notEqualTo',
      field: 'friendPassword',
      fields: ['adminPassword'],
      message: 'Jede Rolle braucht ein eigenes Passwort',
      onlyWhenSet: true,
    },
    {
      rule: 'notEqualTo',
      field: 'guestPassword',
      fields: ['adminPassword', 'friendPassword'],
      message: 'Jede Rolle braucht ein eigenes Passwort',
      onlyWhenSet: true,
    },
  ],

  adapter: { maxPlayersField: 'slotCount' },

  fakeLog: {
    timeFormat: 'iso',
    join: "[{time}] [server] Player '{name}' logged in with Permissions:",
    leave: "[{time}] [server] Remove Player '{name}'",
    ready: '[{time}] [game_server] Switching state from LoadEcsScene to Run after 169.01 ms',
    chatter: '[{time}] [server_save] Read Version: {n}',
  },

  modExtensions: [],

  /* Fester Ort: `SERVER_SAVE_DIR` steht auf `./savegame`, es gibt kein Feld dafür. */
  world: {
    parent: '/opt/enshrouded',
    name: { kind: 'const', value: 'savegame' },
    parts: [{ suffix: '', type: 'dir', required: true }],
    markers: [],
    accept: [],
  },

  backup: {
    paths: ['/opt/enshrouded/savegame'],
    preCommands: [],
    postCommands: [],
  },
};
