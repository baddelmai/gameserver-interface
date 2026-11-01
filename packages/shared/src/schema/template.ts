import { z } from 'zod';
import { gameIdSchema, type LogLevel } from './common.js';
// Nur als Typ — zur Laufzeit gibt es dadurch keinen Zyklus mit dem
// Definitionsschema, das umgekehrt Werte von hier importiert.
import type { TemplateDefinition } from './template-definition.js';

/**
 * Ein Formularfeld einer Vorlage. Aus diesen Specs generiert das Frontend
 * sowohl den Anlege-Wizard als auch den Config-Reiter; das Backend leitet
 * daraus die Container-Umgebung ab.
 */
export const fieldSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['text', 'password', 'number', 'select', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().optional(),
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  /** Feld erscheint nach dem Anlegen im Config-Reiter. */
  editable: z.boolean().default(true),
  /** Änderung wird erst nach einem Neustart der Instanz wirksam. */
  restartRequired: z.boolean().default(true),
  /** Wert wird in API-Antworten maskiert. */
  secret: z.boolean().default(false),
});
export type FieldSpec = z.infer<typeof fieldSpecSchema>;

export const portSpecSchema = z.object({
  name: z.string(),
  label: z.string(),
  container: z.number().int(),
  protocol: z.enum(['tcp', 'udp']),
  defaultHost: z.number().int(),
  /** Wird nicht auf den Host veröffentlicht (z. B. RCON). */
  internalOnly: z.boolean().default(false),
  /**
   * Anzahl aufeinanderfolgender Ports ab `container` bzw. dem Host-Port.
   * Fehlt bei fast allen Vorlagen — ein Port ist der Normalfall.
   *
   * Nötig wurde das mit NetherNet: Bedrock 26.50 gibt jedem Spieler einen
   * eigenen UDP-Port aus einem Bereich, und der Bereich muss vollständig
   * veröffentlicht sein. Optional statt `.default(1)`, damit die zwanzig
   * mitgelieferten Vorlagen nicht jeden Port um `count: 1` ergänzen müssen.
   */
  count: z.number().int().min(1).max(100).optional(),
});
export type PortSpec = z.infer<typeof portSpecSchema>;

export const volumeSpecSchema = z.object({
  name: z.string(),
  containerPath: z.string(),
  role: z.enum(['data', 'config', 'mods']),
});
export type VolumeSpec = z.infer<typeof volumeSpecSchema>;

/**
 * Woher der Name der Welt stammt. Dieselbe Diskriminanten-Union wie bei `env`,
 * aber ohne `port`, `rconPassword` und `timezone` — ein Weltname aus der
 * Zeitzone ergäbe keinen Sinn und wäre nur eine Fehlerquelle mehr.
 */
export const worldNameSourceSchema = z.discriminatedUnion('kind', [
  /** Fester Name, etwa `savegame` bei Enshrouded. */
  z.object({ kind: z.literal('const'), value: z.string().min(1) }),
  /** Wert eines Formularfelds — `levelName`, `worldName`, `saveName`. */
  z.object({ kind: z.literal('field'), field: z.string().min(1) }),
]);
export type WorldNameSource = z.infer<typeof worldNameSourceSchema>;

/**
 * Ein Teil der Welt. Der Pfad ist immer `parent/<stamm><suffix>`.
 *
 * **Der erste Teil ist die Welt selbst** — nach ihm wird der Download benannt,
 * und an ihm hängt die Entscheidung zwischen roher Datei und ZIP. Das ist eine
 * Reihenfolge-Regel und kein eigenes Flag, weil ein zweites Flag neben
 * `required` nur verwechselt würde.
 */
export const worldPartSchema = z.object({
  suffix: z.string().default(''),
  type: z.enum(['dir', 'file']),
  /**
   * Muss beim Einspielen im Archiv stehen. Nicht „ist die Welt selbst“:
   * Valheims `.db` trägt die Karte und ist ohne die `.fwl` wertlos — beide sind
   * erforderlich. Terrarias `.twld` mit den TShock-Regionen dagegen nicht, und
   * Minecrafts `_nether` ebenso wenig.
   */
  required: z.boolean().default(false),
});
export type WorldPart = z.infer<typeof worldPartSchema>;

/**
 * Die Weltdaten einer Instanz — der Ausschnitt, den der Betreiber herunterladen
 * und austauschen kann.
 *
 * Bewusst **nicht** `backup.paths`: die sichern das ganze Datenvolumen samt
 * Konfiguration, Logs und Mods. Und bewusst nicht `volumes[].role`: die Rolle
 * ist in den mitgelieferten Vorlagen widersprüchlich vergeben (Satisfactory
 * nennt `/config` `data`, DST nennt `/data` `config`) und wird nirgends
 * ausgewertet — sie taugt nicht als Quelle dafür, wo die Welt liegt.
 *
 * **Eine Form statt dreier Gestalten.** Naheliegend wären getrennte Zweige für
 * Verzeichnis, Einzeldatei und Dateigruppe. Minecraft widerlegt das: Paper legt
 * die Dimensionen als *Geschwister* an — `welt`, `welt_nether`, `welt_the_end`.
 * Wer nur `welt/` mitnimmt, verliert Nether und End, ohne dass es auffällt.
 * Damit ist Minecraft dieselbe Gestalt wie Valheim, nur mit Verzeichnissen
 * statt Dateien, und `parts` deckt beides ab.
 */
export const worldDefinitionSchema = z.object({
  /** Container-Pfad des Verzeichnisses, in dem die Welt liegt. Muss in einem Volume liegen. */
  parent: z.string().min(1),
  /** Gemeinsamer Stamm aller Teile. */
  name: worldNameSourceSchema,
  parts: z.array(worldPartSchema).min(1),
  /**
   * Dateien, an denen eine Welt in einem hochgeladenen Archiv erkannt wird —
   * `level.dat` bei Minecraft. Ohne Marker entscheidet allein die Struktur.
   */
  markers: z.array(z.string()).default([]),
  /**
   * Endungen, unter denen eine **rohe** Einzeldatei hochgeladen werden darf.
   * Leer heißt: nur ZIP. Ein Factorio-Spielstand *ist* ein ZIP und darf deshalb
   * nie entpackt werden — `.zip` steht dort in `accept` und gewinnt gegen den
   * Archivzweig.
   *
   * Der erste Eintrag ist zugleich die Endung, die beim Herunterladen angehängt
   * wird, wenn die Datei auf der Platte keine hat: Terrarias `WORLD_FILENAME`
   * heißt schlicht `welt`, und eine Datei ohne Endung nützt dem Benutzer nichts.
   */
  accept: z.array(z.string()).default([]),
});
export type WorldDefinition = z.infer<typeof worldDefinitionSchema>;

/**
 * Was eine Vorlage tatsächlich kann. Der Design-Prototyp nimmt an, dass jede
 * Instanz eine Befehlseingabe und Mods hat — real gilt das nur für Minecraft.
 * Die UI blendet Bedienelemente anhand dieser Flags aus oder deaktiviert sie.
 */
export const capabilitiesSchema = z.object({
  /** `rcon`: echte Befehlseingabe. `readonly`: nur Log-Stream. */
  console: z.enum(['rcon', 'readonly']),
  /** Woher die Spielerliste kommt. */
  players: z.enum(['rcon', 'a2s', 'log']),
  /** Ob und wie Mods verwaltet werden. */
  mods: z.enum(['plugins', 'bepinex', 'none']),
  /** Ob Kick/Bann serverseitig möglich ist. */
  moderation: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** JSON-serialisierbarer Teil einer Vorlage — das liefert `GET /api/templates`. */
export const templateDescriptorSchema = z.object({
  id: gameIdSchema,
  label: z.string(),
  /** Kurzbeschreibung für die Auswahlkarte im Wizard. */
  summary: z.string(),
  image: z.string(),
  defaultTag: z.string(),
  ports: z.array(portSpecSchema),
  volumes: z.array(volumeSpecSchema),
  fields: z.array(fieldSpecSchema),
  capabilities: capabilitiesSchema,
  defaultMemoryMb: z.number().int(),
  defaultCpus: z.number(),
  /** Hinweis, der im Wizard und über der Konsole angezeigt wird. */
  notes: z.array(z.string()),
  /**
   * Dateiendungen, die als Mod gelten. Gehört in den Descriptor, weil der
   * Mod-Reiter sie braucht: die Endung war dort fest verdrahtet und behauptete
   * bei jeder Vorlage ohne Java oder BepInEx etwas Falsches.
   */
  modExtensions: z.array(z.string()),
  /**
   * Weltdaten der Vorlage. Gehört in den Descriptor, weil der Welt-Reiter daran
   * hängt: ob es ihn überhaupt gibt (`world` vorhanden), was der Dateidialog
   * annimmt (`accept`) und welche Teile er auflisten soll.
   *
   * Eine eigene Fähigkeit in `capabilities` wäre eine zweite Wahrheit über
   * dieselbe Sache und könnte davon abweichen; das Vorhandensein des Blocks
   * genügt.
   */
  world: worldDefinitionSchema.optional(),
});
export type TemplateDescriptor = z.infer<typeof templateDescriptorSchema>;

export type FieldValues = Record<string, string | number | boolean>;

/** Vollständige Vorlage inklusive der nicht serialisierbaren Backend-Logik. */
export interface GameTemplate extends TemplateDescriptor {
  /**
   * Die Daten, aus denen diese Vorlage kompiliert wurde. Der Server braucht
   * sie für die Adapter-Hinweise, die Fake-Runtime und zum Zurückschreiben in
   * die Datenbank.
   */
  definition: TemplateDefinition;
  /** Bildet die Formularwerte auf Container-Umgebungsvariablen ab. */
  env(values: FieldValues, ctx: TemplateContext): Record<string, string>;
  /**
   * Startargumente des Containers. Leeres Ergebnis heißt: das Kommando des
   * Images bleibt unangetastet.
   */
  args(values: FieldValues, ctx: TemplateContext): string[];
  /** Optionale Konfigurationsdateien, die vor dem Start ins Volume geschrieben werden. */
  configFiles?(values: FieldValues, ctx: TemplateContext): ConfigFile[];
  logPatterns: LogPatterns;
  backup: BackupSpec;
  /**
   * Container-Pfad des Mod-Verzeichnisses. Fehlt, wenn die Vorlage keine Mods
   * unterstützt (`capabilities.mods === 'none'`).
   */
  modsPath?: string;
}

export interface TemplateContext {
  /** Auf dem Host veröffentlichte Ports, nach `PortSpec.name`. */
  hostPorts: Record<string, number>;
  /** Generiertes RCON-Passwort, sofern die Vorlage RCON nutzt. */
  rconPassword?: string;
  /** Zeitzone des Hosts. */
  timezone: string;
}

export interface ConfigFile {
  /** Pfad relativ zum Container-Volume-Wurzelpfad. */
  path: string;
  content: string;
}

export interface LogPatterns {
  /** Erkennt einen beitretenden Spieler; Gruppe 1 ist der Name. */
  join: RegExp;
  /** Erkennt einen abgemeldeten Spieler; Gruppe 1 ist der Name, falls vorhanden. */
  leave?: RegExp;
  /** Zeigt an, dass der Server fertig hochgefahren ist. */
  ready: RegExp;
  /** Stuft eine rohe Logzeile ein. */
  level(line: string): LogLevel;
  /** Entfernt Zeitstempel und Präfixe der Spiel-Engine aus der Zeile. */
  clean?(line: string): string;
}

export interface BackupSpec {
  /** Zu sichernde Pfade im Container. */
  paths: string[];
  /** Vor dem Sichern abzusetzende Konsolenbefehle (nur bei `console: 'rcon'`). */
  preCommands?: string[];
  /** Danach abzusetzende Befehle — laufen auch, wenn das Sichern fehlschlägt. */
  postCommands?: string[];
}
