import type { TemplateDefinition } from '../schema/template-definition.js';

/**
 * Valheim auf Basis von `lloesche/valheim-server`.
 *
 * Wichtig: Das Valheim-Binary nimmt keine Befehle über stdin entgegen und hat
 * kein RCON — Admin-Befehle gibt es nur im Spiel über die F5-Konsole. Die
 * Panel-Konsole ist deshalb read-only. Die Spielerzahl kommt per Steam-A2S-Query
 * vom Query-Port, die Namen aus den `ZDOID`-Zeilen des Logs.
 */
export const valheimDefinition: TemplateDefinition = {
  id: 'valheim',
  label: 'Valheim',
  summary: 'Dedizierter Valheim-Server mit BepInEx-Unterstützung. Spielerzahl per Steam-Query, Konsole nur lesend.',
  image: 'lloesche/valheim-server',
  defaultTag: 'latest',
  defaultMemoryMb: 8192,
  defaultCpus: 4,
  notes: [
    'Valheim kennt kein RCON — die Konsole zeigt nur den Log-Stream, Befehle sind nicht möglich.',
    'Kick und Bann müssen im Spiel über die Admin-Konsole (F5) erfolgen.',
    'Ein gesetztes Serverpasswort muss mindestens 5 Zeichen haben und darf nicht im Server- oder Weltnamen vorkommen.',
  ],
  capabilities: {
    console: 'readonly',
    players: 'a2s',
    mods: 'bepinex',
    moderation: false,
  },
  ports: [
    { name: 'game', label: 'Spielport', container: 2456, protocol: 'udp', defaultHost: 2456, internalOnly: false },
    { name: 'query', label: 'Query-Port', container: 2457, protocol: 'udp', defaultHost: 2457, internalOnly: false },
  ],
  volumes: [
    { name: 'config', containerPath: '/config', role: 'config' },
    { name: 'data', containerPath: '/opt/valheim', role: 'data' },
  ],
  fields: [
    {
      id: 'serverName', label: 'Servername', type: 'text', default: 'Valheim Server',
      required: true, maxLength: 48, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'worldName', label: 'Welt', type: 'text', default: 'Dedicated',
      required: true, maxLength: 40, editable: false, restartRequired: true, secret: false,
      help: 'Name der Weltdatei — nach dem Anlegen nicht mehr änderbar.',
    },
    {
      // Optional: ein Valheim-Server darf ohne Passwort laufen. Ist eines
      // gesetzt, greifen die Regeln des Spiels (siehe `validations`).
      id: 'password', label: 'Passwort', type: 'password', default: '',
      required: false, maxLength: 64, editable: true, restartRequired: true, secret: true,
      help: 'Leer lassen für einen offenen Server. Sonst mindestens 5 Zeichen, und nicht Teil des Server- oder Weltnamens.',
    },
    {
      id: 'public', label: 'Öffentlich gelistet', type: 'boolean', default: true,
      required: false, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'crossplay', label: 'Crossplay', type: 'boolean', default: true,
      required: false, editable: true, restartRequired: true, secret: false,
      help: 'Erlaubt Beitritt über PlayFab zusätzlich zu Steam.',
    },
    {
      id: 'preset', label: 'Weltmodus', type: 'select', default: 'normal',
      options: [
        { value: 'casual', label: 'entspannt' },
        { value: 'easy', label: 'einfach' },
        { value: 'normal', label: 'normal' },
        { value: 'hard', label: 'schwer' },
        { value: 'hardcore', label: 'hardcore' },
      ],
      required: true, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'bepinex', label: 'BepInEx (Mods)', type: 'boolean', default: false,
      required: false, editable: true, restartRequired: true, secret: false,
      help: 'Lädt das Mod-Framework beim Start. Ohne BepInEx ist der Mod-Reiter leer.',
    },
    {
      id: 'updateCron', label: 'Update-Zeitplan', type: 'text', default: '0 5 * * *',
      required: false, maxLength: 40, editable: true, restartRequired: true, secret: false,
      help: 'Cron-Ausdruck für die automatische Spiel-Aktualisierung. Leer = aus.',
    },
  ],

  env: [
    { name: 'SERVER_NAME', source: { kind: 'field', field: 'serverName' }, fallback: 'Valheim Server', trim: false, omitWhenEmpty: false },
    { name: 'WORLD_NAME', source: { kind: 'field', field: 'worldName' }, fallback: 'Dedicated', trim: false, omitWhenEmpty: false },
    // Ohne Passwort darf die Variable nicht gesetzt sein: ein leeres SERVER_PASS
    // lässt das Image mit einer Passwortprüfung abbrechen.
    { name: 'SERVER_PASS', source: { kind: 'field', field: 'password' }, trim: false, omitWhenEmpty: true },
    { name: 'SERVER_PORT', source: { kind: 'port', port: 'game' }, fallback: '2456', trim: false, omitWhenEmpty: false },
    {
      name: 'SERVER_PUBLIC', source: { kind: 'field', field: 'public' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'true', trim: false, omitWhenEmpty: false,
    },
    {
      name: 'SERVER_ARGS', source: { kind: 'field', field: 'crossplay' },
      boolean: { whenTrue: '-crossplay', whenFalse: '' }, fallback: '-crossplay', trim: false, omitWhenEmpty: false,
    },
    { name: 'SERVER_PRESET', source: { kind: 'field', field: 'preset' }, fallback: 'normal', trim: false, omitWhenEmpty: false },
    {
      name: 'BEPINEX', source: { kind: 'field', field: 'bepinex' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'false', trim: false, omitWhenEmpty: false,
    },
    // Backups macht das Panel, damit Zeitplan und Aufbewahrung an einer Stelle liegen.
    { name: 'BACKUPS', source: { kind: 'const', value: 'false' }, trim: false, omitWhenEmpty: false },
    { name: 'UPDATE_CRON', source: { kind: 'field', field: 'updateCron' }, fallback: '', trim: false, omitWhenEmpty: false },
    { name: 'TZ', source: { kind: 'timezone' }, trim: false, omitWhenEmpty: false },
  ],

  logPatterns: {
    // `Got character ZDOID from Freyja_88 : -12345:6` — beim Beitritt und bei jedem Respawn.
    join: { source: 'Got character ZDOID from (\\S+)\\s*:', flags: '' },
    // Valheim protokolliert beim Verlassen keinen Namen, nur die Socket-Kennung.
    // Die Spielerliste wird deshalb gegen die A2S-Zählung abgeglichen.
    ready: { source: '(DungeonDB Start|Game server connected)', flags: '' },
    clean: {
      pattern: { source: '^\\s*\\d{2}\\/\\d{2}\\/\\d{4} \\d{2}:\\d{2}:\\d{2}:\\s*', flags: '' },
      replacement: '',
    },
  },

  validations: [
    {
      rule: 'minLength',
      field: 'password',
      value: 5,
      message: 'Valheim verlangt mindestens 5 Zeichen',
      onlyWhenSet: true,
    },
    {
      rule: 'notContainedIn',
      field: 'password',
      fields: ['serverName', 'worldName'],
      message: 'Das Passwort darf nicht im Server- oder Weltnamen vorkommen',
      onlyWhenSet: true,
    },
  ],

  adapter: { queryPortName: 'query' },

  fakeLog: {
    timeFormat: 'dmy',
    join: '{time}: Got character ZDOID from {name} : -{n}:1',
    leave: '{time}: Closing socket {n}',
    ready: '{time}: DungeonDB Start {n}',
    chatter: '{time}: World saved ( {n}ms )',
  },

  modsPath: '/config/bepinex/plugins',
  modExtensions: ['.dll'],

  /*
   * Seit Valheim 1.0 ist eine Welt kein Dateipaar mehr, sondern ein
   * Verzeichnis: `worlds_local/<Weltname>/` enthält mehrere Generationen aus
   * `_main.N.fwl2`, `_main.N.db2`, `_main.N.chunks` und `_main.N.ok` sowie ein
   * `.chunk` je Geländestück; N zählt bei jedem Speichern hoch, geladen wird
   * die höchste Generation mit vorhandener `.ok`-Datei. Eine ältere Welt aus
   * dem `.fwl`/`.db`-Paar liegt bis zum nächsten Speichern unverändert daneben
   * und wird dann vom Server selbst in dieses Format überführt.
   */
  world: {
    parent: '/config/worlds_local',
    name: { kind: 'field', field: 'worldName' },
    parts: [{ suffix: '', type: 'dir', required: true }],
    markers: [],
    accept: [],
  },

  backup: {
    paths: ['/config/worlds_local'],
    preCommands: [],
    postCommands: [],
  },
};
