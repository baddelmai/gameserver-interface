import { z } from 'zod';
import {
  capabilitiesSchema,
  fieldSpecSchema,
  portSpecSchema,
  volumeSpecSchema,
  worldDefinitionSchema,
} from './template.js';

/**
 * Die serialisierbare Fassung einer Vorlage. `GameTemplate` enthält Funktionen
 * und RegExp und kann deshalb weder gespeichert noch über die API bearbeitet
 * werden; diese Struktur beschreibt dasselbe rein als Daten, und
 * `compileTemplate()` macht daraus wieder ein `GameTemplate`.
 *
 * Feldnamen sind englisch, weil die Definition über die API geht — dieselbe
 * Regel wie bei den übrigen Schemas. Kommentare und Oberfläche sind deutsch.
 */

/** Woher der Wert einer Umgebungsvariablen stammt. */
export const envSourceSchema = z.discriminatedUnion('kind', [
  /** Fester Wert, unabhängig von den Einstellungen (`EULA=TRUE`). */
  z.object({ kind: z.literal('const'), value: z.string() }),
  /** Wert eines Formularfelds. */
  z.object({ kind: z.literal('field'), field: z.string() }),
  /** Auf dem Host veröffentlichter Port, nach `PortSpec.name`. */
  z.object({ kind: z.literal('port'), port: z.string() }),
  /** Das erzeugte RCON-Passwort — nur sinnvoll bei `console: 'rcon'`. */
  z.object({ kind: z.literal('rconPassword') }),
  /** Zeitzone des Hosts. */
  z.object({ kind: z.literal('timezone') }),
]);
export type EnvSource = z.infer<typeof envSourceSchema>;

export const envMappingSchema = z.object({
  /** Name der Umgebungsvariablen im Container. */
  name: z.string().min(1),
  source: envSourceSchema,
  /** Wert, wenn die Quelle nichts liefert. Ersetzt das `?? '…'` der alten Funktionen. */
  fallback: z.string().optional(),
  /**
   * Übersetzung eines `boolean`-Felds. Ohne diese Angabe würde `true` als
   * `"true"` geschrieben — die Images erwarten aber `TRUE`, `-crossplay` und
   * anderes.
   */
  boolean: z.object({ whenTrue: z.string(), whenFalse: z.string() }).optional(),
  /** Leerraum am Rand entfernen, bevor der Wert geprüft und gesetzt wird. */
  trim: z.boolean().default(false),
  /** Variable weglassen statt leer zu setzen — für optionale Passwörter und Seeds. */
  omitWhenEmpty: z.boolean().default(false),
});
export type EnvMapping = z.infer<typeof envMappingSchema>;

/**
 * Ein Startargument des Containers.
 *
 * Nicht jedes Image lässt sich über Umgebungsvariablen einrichten: `ryshe/terraria`
 * etwa kennt genau zwei und erwartet alles Weitere als Argument — ohne
 * `-autocreate` bleibt der Server sogar im interaktiven Einrichtungsdialog
 * stehen und kommt nie hoch. Die Quellen sind dieselben wie bei `env`.
 */
export const argMappingSchema = z.object({
  /** Feste Zeichenkette davor, etwa `-world`. Leer lassen für einen bloßen Wert. */
  flag: z.string().default(''),
  source: envSourceSchema.optional(),
  fallback: z.string().optional(),
  boolean: z.object({ whenTrue: z.string(), whenFalse: z.string() }).optional(),
  trim: z.boolean().default(false),
  /** Argument samt Flag weglassen, wenn der Wert leer ist. */
  omitWhenEmpty: z.boolean().default(false),
});
export type ArgMapping = z.infer<typeof argMappingSchema>;

/** Ein regulärer Ausdruck als Daten. */
export const patternSchema = z.object({
  source: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/).default(''),
});
export type PatternSpec = z.infer<typeof patternSchema>;

export const logPatternsDefinitionSchema = z.object({
  /** Erkennt einen beitretenden Spieler; Gruppe 1 ist der Name. */
  join: patternSchema,
  /** Erkennt einen abgemeldeten Spieler. Fehlt, wenn das Spiel das nicht protokolliert. */
  leave: patternSchema.optional(),
  /** Zeigt an, dass der Server fertig hochgefahren ist. */
  ready: patternSchema,
  /**
   * Entfernt Zeitstempel und Präfixe der Engine. Das Ergebnis wird immer noch
   * am Ende beschnitten, wie es alle drei ursprünglichen Vorlagen taten.
   */
  clean: z.object({ pattern: patternSchema, replacement: z.string().default('') }).optional(),
  /**
   * Eigene Schlüsselwörter für die Einstufung. Ohne Angabe gilt die
   * gemeinsame Heuristik aus `templates/util.ts`.
   */
  level: z
    .object({
      error: z.array(z.string()).default([]),
      warn: z.array(z.string()).default([]),
    })
    .optional(),
});
export type LogPatternsDefinition = z.infer<typeof logPatternsDefinitionSchema>;

/**
 * Prüfungen, die sich nicht aus den Feld-Specs ergeben. Ersetzt die früheren
 * `if (template.id === 'valheim')`-Blöcke in `validateSettings()`.
 */
export const validationRuleSchema = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('required'), field: z.string(), message: z.string() }),
  z.object({
    rule: z.literal('minLength'),
    field: z.string(),
    value: z.number().int().positive(),
    message: z.string(),
    /** Nur prüfen, wenn überhaupt etwas eingetragen ist. */
    onlyWhenSet: z.boolean().default(true),
  }),
  z.object({
    rule: z.literal('pattern'),
    field: z.string(),
    pattern: patternSchema,
    message: z.string(),
    onlyWhenSet: z.boolean().default(true),
  }),
  /** Der Wert darf in keinem der genannten Felder als Teilzeichenkette vorkommen. */
  z.object({
    rule: z.literal('notContainedIn'),
    field: z.string(),
    fields: z.array(z.string()).min(1),
    message: z.string(),
    onlyWhenSet: z.boolean().default(true),
  }),
  /** Der Wert darf keinem der genannten Felder gleichen — etwa zwei Rollenpasswörter. */
  z.object({
    rule: z.literal('notEqualTo'),
    field: z.string(),
    fields: z.array(z.string()).min(1),
    message: z.string(),
    onlyWhenSet: z.boolean().default(true),
  }),
]);
export type ValidationRule = z.infer<typeof validationRuleSchema>;

/**
 * Die zwei Angaben, die die generischen Adapter über das Spiel brauchen. Alles
 * andere leiten sie aus `capabilities` ab.
 */
export const adapterHintsSchema = z.object({
  /** Port für die Steam-Abfrage, nach `PortSpec.name` — nur bei `players: 'a2s'`. */
  queryPortName: z.string().optional(),
  /** Feld, das die Slotzahl trägt — für die Anzeige „x / y Spieler“. */
  maxPlayersField: z.string().optional(),
  /**
   * Port der RCON-Konsole, nach `PortSpec.name` — nur bei `console: 'rcon'`.
   * Verbunden wird der **Container**-Port, nicht der Host-Port: RCON wird
   * üblicherweise nicht veröffentlicht, das Panel erreicht es über das
   * Container-Netz.
   */
  rconPortName: z.string().optional(),
  /**
   * Befehl, der die Spielerliste liefert, und das Format seiner Antwort —
   * nur bei `players: 'rcon'`. Ohne Angabe bleibt es bei Minecrafts `list`.
   */
  rconListCommand: z.string().optional(),
  rconListFormat: z.enum(['minecraft', 'csv']).optional(),
});
export type AdapterHints = z.infer<typeof adapterHintsSchema>;

/**
 * Logzeilen für die Fake-Runtime, im echten Format des Spiels. Platzhalter:
 * `{time}` (nach `timeFormat`), `{name}`, `{n}` (Zähler).
 *
 * Sie stehen bewusst neben den Mustern in derselben Definition: früher lagen
 * Muster und Simulation in verschiedenen Dateien, und wer eines änderte, testete
 * anschließend an der Realität vorbei.
 */
export const fakeLogSchema = z.object({
  timeFormat: z.enum(['hms', 'dmy', 'iso']).default('hms'),
  join: z.string(),
  leave: z.string(),
  ready: z.string(),
  /** Beiläufige Zeile ohne Bedeutung, damit der Log-Strom lebt. */
  chatter: z.string(),
});
export type FakeLogSpec = z.infer<typeof fakeLogSchema>;

export const backupDefinitionSchema = z.object({
  /** Zu sichernde Pfade im Container; müssen in den deklarierten Volumes liegen. */
  paths: z.array(z.string()).min(1),
  /** Vor dem Sichern abzusetzende Konsolenbefehle — nur bei `console: 'rcon'`. */
  preCommands: z.array(z.string()).default([]),
  /** Danach abzusetzende Befehle; laufen auch, wenn das Sichern fehlschlägt. */
  postCommands: z.array(z.string()).default([]),
});

/** Kennung einer Vorlage: klein, ohne Leerzeichen — sie wird zum Container-Label. */
export const templateIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche, 2–32 Zeichen');

export const templateDefinitionSchema = z.object({
  id: templateIdSchema,
  label: z.string().min(1),
  summary: z.string().min(1),
  image: z.string().min(1),
  defaultTag: z.string().min(1),
  defaultMemoryMb: z.number().int().positive(),
  defaultCpus: z.number().positive(),
  notes: z.array(z.string()).default([]),
  capabilities: capabilitiesSchema,
  ports: z.array(portSpecSchema).min(1),
  volumes: z.array(volumeSpecSchema).min(1),
  fields: z.array(fieldSpecSchema).default([]),
  env: z.array(envMappingSchema).default([]),
  /**
   * Startargumente des Containers. Fehlt bei den meisten Vorlagen — dann bleibt
   * das Kommando des Images unangetastet, was der Normalfall ist.
   */
  args: z.array(argMappingSchema).optional(),
  logPatterns: logPatternsDefinitionSchema,
  backup: backupDefinitionSchema,
  validations: z.array(validationRuleSchema).default([]),
  adapter: adapterHintsSchema.default({}),
  fakeLog: fakeLogSchema.optional(),
  /** Container-Pfad des Mod-Verzeichnisses; fehlt bei `mods: 'none'`. */
  modsPath: z.string().optional(),
  /** Dateiendungen, die als Mod gelten. */
  modExtensions: z.array(z.string()).default([]),
  /**
   * Weltdaten für Herunterladen und Austausch. Fehlt bei Vorlagen ohne Welt —
   * CS2, TF2 und Garry's Mod sichern nur `cfg`-Verzeichnisse, ein Welt-Reiter
   * darüber wäre eine Lüge.
   *
   * Optional statt `.default({})`: sonst bekämen diese drei einen leeren Block,
   * und „hat diese Vorlage eine Welt?" bräuchte eine zweite Bedingung.
   */
  world: worldDefinitionSchema.optional(),
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

/** Eingabe beim Anlegen oder Bearbeiten — dieselbe Struktur, vor der Vorbelegung. */
export type TemplateDefinitionInput = z.input<typeof templateDefinitionSchema>;
