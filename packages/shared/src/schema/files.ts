import { z } from 'zod';

/**
 * Konfigurationsdateien einer Instanz direkt bearbeiten — die Alternative zum
 * Formular im Config-Reiter.
 *
 * Adressiert wird immer **Volume plus relativer Pfad**, nie ein Container- oder
 * Host-Pfad. Damit kann die API gar nicht erst einen Ort außerhalb der Volumes
 * benennen; der Server prüft trotzdem ein zweites Mal.
 */

/**
 * Obergrenze für eine bearbeitbare Datei. Konfigurationen sind Kilobytes groß;
 * was darüber liegt, ist ein Log, eine Datenbank oder eine Welt, und eine
 * Textarea mit mehreren Megabyte macht den Browser ohnehin unbedienbar.
 */
export const FILE_EDIT_MAX_BYTES = 1024 * 1024;

/**
 * Mehr Einträge zeigt ein Verzeichnis nicht. Enshrouded und Valheim installieren
 * den ganzen Server ins Volume — ein Verzeichnis mit Tausenden DLLs soll die
 * Antwort nicht aufblähen.
 */
export const FILE_LIST_MAX_ENTRIES = 1000;

/**
 * Endungen, die als Konfiguration gelten. Nur für die Vorauswahl der Liste —
 * öffnen lässt sich jede Textdatei, ob sie Text ist, entscheidet der Inhalt.
 */
export const CONFIG_EXTENSIONS = [
  '.cfg',
  '.conf',
  '.config',
  '.env',
  '.ini',
  '.json',
  '.json5',
  '.lua',
  '.properties',
  '.toml',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
];

export const fileEntrySchema = z.object({
  name: z.string(),
  /** Pfad relativ zum Volume, mit `/` getrennt — so wird er zurückgeschickt. */
  path: z.string(),
  type: z.enum(['dir', 'file']),
  sizeBytes: z.number(),
  modifiedAt: z.string().nullable(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileListingSchema = z.object({
  volume: z.string(),
  /** Leer für die Wurzel des Volumes. */
  path: z.string(),
  entries: z.array(fileEntrySchema),
  /** Es gab mehr als `FILE_LIST_MAX_ENTRIES` Einträge. */
  truncated: z.boolean(),
});
export type FileListing = z.infer<typeof fileListingSchema>;

export const fileContentSchema = z.object({
  volume: z.string(),
  path: z.string(),
  /** Inhalt mit `\n` als Zeilenende und ohne BOM — beides stellt der Server beim Speichern wieder her. */
  content: z.string(),
  /**
   * Stand der Datei beim Lesen. Wer speichert, schickt ihn mit; hat sich die
   * Datei inzwischen geändert — etwa weil der Server sie beim Beenden
   * zurückschrieb —, antwortet der Server mit 409, statt das zu überschreiben.
   */
  rev: z.string(),
  sizeBytes: z.number(),
  modifiedAt: z.string(),
  lineEnding: z.enum(['lf', 'crlf']),
});
export type FileContent = z.infer<typeof fileContentSchema>;

export const saveFileRequestSchema = z.object({
  volume: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  rev: z.string().min(1),
  /** Syntaxprüfung überspringen — für JSON mit Kommentaren, das ein Spiel trotzdem liest. */
  force: z.boolean().default(false),
  /** Instanz nach dem Speichern neu starten. Kein Neuaufbau: Dateien wirken ohne. */
  restart: z.boolean().default(false),
});
export type SaveFileRequest = z.infer<typeof saveFileRequestSchema>;
