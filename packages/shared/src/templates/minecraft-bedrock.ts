import type { TemplateDefinition } from '../schema/template-definition.js';

/**
 * Minecraft Bedrock Edition auf Basis von `itzg/minecraft-bedrock-server`.
 *
 * Nicht zu verwechseln mit der Java-Vorlage: Bedrock ist die Fassung für
 * Konsolen, Mobilgeräte und Windows, spricht ein anderes Protokoll und läuft
 * über **UDP**. Beide Server können nebeneinander laufen; Spieler der einen
 * Fassung kommen nicht auf den Server der anderen.
 *
 * Anders als die Java-Ausgabe kennt Bedrock **kein RCON**. Die Konsole ist
 * deshalb nur lesend, und Spielernamen kommen aus dem Log.
 *
 * **NetherNet statt RakNet.** Seit BDS 26.50 ist NetherNet die Vorgabe, seit
 * Client 26.60 verbinden sich Spieler nicht mehr über RakNet. Damit sieht das
 * Netz anders aus als früher:
 * - Der Verbindungsaufbau läuft über **TCP** 19132. Auf UDP 19132 lauscht der
 *   Server gar nicht mehr.
 * - Die Spieldaten laufen über **einen UDP-Port je Spieler** aus einem Bereich.
 *   Ohne festen Bereich nähme der Server zufällige Ports, die Docker nicht
 *   veröffentlicht — die Verbindung bliebe beim Laden hängen.
 * - Beim Verbindungsaufbau nennt der Server dem Client Adresse und Ports der
 *   Spieldaten. Im Bridge-Netz von Docker kennt er beides nicht selbst, deshalb
 *   steht es in `SERVER_UDP_PORTS`, gebaut aus Feld und Portbereich.
 *
 * Belegt an der README von `itzg/docker-minecraft-bedrock-server` (Abschnitt
 * „NetherNet") und an Hoster-Anleitungen, Stand 01.11.2026. Gegen einen echten
 * Client noch ungeprüft.
 *
 * Die Variablen setzen die gleichnamigen Einträge der `server.properties`; sie
 * sind in der Docker-Hub-Beschreibung aufgeführt.
 */
export const minecraftBedrockDefinition: TemplateDefinition = {
  id: 'minecraft-bedrock',
  label: 'Minecraft (Bedrock)',
  summary: 'Bedrock-Server für Konsole, Mobil und Windows. Läuft über UDP, Konsole nur lesend, keine Plugins.',
  image: 'itzg/minecraft-bedrock-server',
  defaultTag: 'latest',
  defaultMemoryMb: 2048,
  defaultCpus: 2,
  notes: [
    'Mit dem Anlegen wird die Minecraft-EULA akzeptiert (EULA=TRUE).',
    'Bedrock kennt kein RCON — die Konsole zeigt nur den Log-Stream.',
    'Spieler der Java-Ausgabe können sich hier nicht verbinden; dafür gibt es die Vorlage „Minecraft“.',
    'Seit Bedrock 26.50 läuft die Verbindung über NetherNet: Router und Firewall müssen den TCP-Verbindungsport und den ganzen UDP-Bereich durchlassen — UDP 19132 allein genügt nicht mehr.',
  ],
  capabilities: {
    console: 'readonly',
    players: 'log',
    mods: 'none',
    moderation: false,
  },
  ports: [
    // Der Name `game` bleibt, obwohl es jetzt der TCP-Verbindungsport ist:
    // bestehende Instanzen haben ihren Host-Port unter diesem Namen gespeichert,
    // und die Adresse im Detailkopf richtet sich nach ihm.
    { name: 'game', label: 'Verbindungsport', container: 19132, protocol: 'tcp', defaultHost: 19132, internalOnly: false },
    { name: 'udp', label: 'Spieldaten', container: 19140, protocol: 'udp', defaultHost: 19140, internalOnly: false, count: 20 },
  ],
  volumes: [{ name: 'data', containerPath: '/data', role: 'data' }],
  fields: [
    {
      id: 'serverName', label: 'Servername', type: 'text', default: 'Bedrock Server',
      required: true, maxLength: 48, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'levelName', label: 'Welt', type: 'text', default: 'Bedrock level',
      required: true, maxLength: 40, editable: false, restartRequired: true, secret: false,
      help: 'Verzeichnisname der Welt — nach dem Anlegen nicht mehr änderbar.',
    },
    {
      id: 'levelSeed', label: 'Seed', type: 'text', default: '',
      required: false, maxLength: 40, editable: false, restartRequired: true, secret: false,
      help: 'Leer lassen für eine zufällige Welt.',
    },
    {
      id: 'gamemode', label: 'Spielmodus', type: 'select', default: 'survival',
      options: [
        { value: 'survival', label: 'Überleben' },
        { value: 'creative', label: 'Kreativ' },
        { value: 'adventure', label: 'Abenteuer' },
      ],
      required: true, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'difficulty', label: 'Schwierigkeit', type: 'select', default: 'easy',
      options: [
        { value: 'peaceful', label: 'friedlich' },
        { value: 'easy', label: 'einfach' },
        { value: 'normal', label: 'normal' },
        { value: 'hard', label: 'hart' },
      ],
      required: true, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'maxPlayers', label: 'Slots', type: 'number', default: 10,
      min: 1, max: 20, required: true, editable: true, restartRequired: true, secret: false,
      help: 'Höchstens 20 — jeder Spieler braucht einen eigenen UDP-Port, und die Vorlage veröffentlicht 20.',
    },
    {
      id: 'publicAddress', label: 'Erreichbar unter', type: 'text', default: '<public_ip>',
      required: true, maxLength: 64, editable: true, restartRequired: true, secret: false,
      help: 'IP-Adresse, die der Server den Spielern für die Spieldaten nennt. „<public_ip>“ ermittelt beim Start die öffentliche IP (Portweiterleitung im Router nötig). Nur im Heimnetz: die LAN-IP des Hosts, etwa 192.168.1.10. Kein Hostname.',
    },
    {
      id: 'allowCheats', label: 'Cheats erlauben', type: 'boolean', default: false,
      required: false, editable: true, restartRequired: true, secret: false,
    },
    {
      id: 'onlineMode', label: 'Xbox-Live-Konto verlangen', type: 'boolean', default: true,
      required: false, editable: true, restartRequired: true, secret: false,
      help: 'Nur für abgeschottete Netze abschalten.',
    },
    {
      id: 'allowList', label: 'Zulassungsliste', type: 'boolean', default: false,
      required: false, editable: true, restartRequired: true, secret: false,
      help: 'Nur Spieler aus allowlist.json dürfen beitreten (früher Whitelist).',
    },
    {
      id: 'viewDistance', label: 'Sichtweite', type: 'number', default: 10,
      min: 5, max: 32, required: true, editable: true, restartRequired: true, secret: false,
      help: 'In Chunks. Höhere Werte kosten spürbar CPU und RAM.',
    },
  ],

  env: [
    { name: 'EULA', source: { kind: 'const', value: 'TRUE' }, trim: false, omitWhenEmpty: false },
    { name: 'SERVER_NAME', source: { kind: 'field', field: 'serverName' }, fallback: 'Bedrock Server', trim: false, omitWhenEmpty: false },
    { name: 'LEVEL_NAME', source: { kind: 'field', field: 'levelName' }, fallback: 'Bedrock level', trim: false, omitWhenEmpty: false },
    { name: 'GAMEMODE', source: { kind: 'field', field: 'gamemode' }, fallback: 'survival', trim: false, omitWhenEmpty: false },
    { name: 'DIFFICULTY', source: { kind: 'field', field: 'difficulty' }, fallback: 'easy', trim: false, omitWhenEmpty: false },
    { name: 'MAX_PLAYERS', source: { kind: 'field', field: 'maxPlayers' }, fallback: '10', trim: false, omitWhenEmpty: false },
    {
      name: 'ALLOW_CHEATS', source: { kind: 'field', field: 'allowCheats' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'false', trim: false, omitWhenEmpty: false,
    },
    {
      name: 'ONLINE_MODE', source: { kind: 'field', field: 'onlineMode' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'true', trim: false, omitWhenEmpty: false,
    },
    {
      name: 'ALLOW_LIST', source: { kind: 'field', field: 'allowList' },
      boolean: { whenTrue: 'true', whenFalse: 'false' }, fallback: 'false', trim: false, omitWhenEmpty: false,
    },
    { name: 'VIEW_DISTANCE', source: { kind: 'field', field: 'viewDistance' }, fallback: '10', trim: false, omitWhenEmpty: false },
    // Der Container-Port, nicht der Host-Port: Docker leitet den Host-Port auf
    // 19132 im Container weiter. Früher stand hier der Host-Port, und jede
    // Instanz mit einem anderen Port als 19132 lauschte ins Leere.
    { name: 'SERVER_PORT', source: { kind: 'const', value: '19132' }, trim: false, omitWhenEmpty: false },
    { name: 'TRANSPORT', source: { kind: 'const', value: 'nethernet' }, trim: false, omitWhenEmpty: false },
    {
      name: 'SERVER_UDP_PORTS', source: { kind: 'portMapping', port: 'udp', addressField: 'publicAddress' },
      trim: false, omitWhenEmpty: false,
    },
    { name: 'TZ', source: { kind: 'timezone' }, trim: false, omitWhenEmpty: false },
    // Leerer Seed bedeutet Zufallswelt.
    { name: 'LEVEL_SEED', source: { kind: 'field', field: 'levelSeed' }, trim: true, omitWhenEmpty: true },
  ],

  logPatterns: {
    // `[2026-09-09 03:11:58 INFO] Player connected: Kai, xuid: 2535465768754321`
    join: { source: 'Player connected: (.+?), xuid:', flags: '' },
    leave: { source: 'Player disconnected: (.+?), xuid:', flags: '' },
    ready: { source: 'Server started\\.', flags: '' },
    clean: {
      pattern: { source: '^\\s*\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}[^\\]]*\\]\\s*', flags: '' },
      replacement: '',
    },
  },

  validations: [
    {
      rule: 'pattern',
      field: 'publicAddress',
      // `<public_ip>`, IPv4 oder IPv6 in eckigen Klammern — das Image verlangt
      // ein Adressliteral, keinen Hostnamen.
      pattern: { source: '^(<public_ip>|\\d{1,3}(\\.\\d{1,3}){3}|\\[[0-9A-Fa-f:]+\\])$', flags: '' },
      message: 'Eine IP-Adresse (IPv6 in eckigen Klammern) oder <public_ip> — kein Hostname',
      onlyWhenSet: true,
    },
    {
      rule: 'pattern',
      field: 'levelName',
      pattern: { source: '^[A-Za-z0-9 _.-]+$', flags: '' },
      message: 'Nur Buchstaben, Ziffern, Leerzeichen und . _ -',
      onlyWhenSet: true,
    },
  ],

  adapter: { maxPlayersField: 'maxPlayers' },

  fakeLog: {
    timeFormat: 'iso',
    join: '[{time} INFO] Player connected: {name}, xuid: 25354657687{n}',
    leave: '[{time} INFO] Player disconnected: {name}, xuid: 25354657687{n}',
    ready: '[{time} INFO] Server started.',
    chatter: '[{time} INFO] Running AutoCompaction... ({n} ms)',
  },

  modExtensions: [],

  /* Bedrock legt jede Welt als eigenes Verzeichnis unter `worlds/` ab. */
  world: {
    parent: '/data/worlds',
    name: { kind: 'field', field: 'levelName' },
    parts: [{ suffix: '', type: 'dir', required: true }],
    markers: ['level.dat'],
    accept: [],
  },

  backup: {
    paths: ['/data/worlds'],
    preCommands: [],
    postCommands: [],
  },
};
