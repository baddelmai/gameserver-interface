import { z } from 'zod';

/**
 * Instanzstatus. Die ersten drei stammen aus dem Design-Prototyp, `Stoppt` und
 * `Fehler` ergänzen die im Handoff als fehlend markierten Fehlerzustände.
 */
export const instanceStatusSchema = z.enum(['Online', 'Offline', 'Startet', 'Stoppt', 'Fehler']);
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

export const logLevelSchema = z.enum(['INFO', 'WARN', 'ERROR', 'CMD']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/**
 * Kennung einer Vorlage. Früher ein geschlossenes Enum der drei eingebauten
 * Spiele — seit Vorlagen zur Laufzeit anlegbar sind, kann die Menge nicht mehr
 * im Code feststehen. Das Muster hält sie trotzdem eng: die ID wird zum
 * Container-Label und zum Pfadbestandteil.
 */
export const gameIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche, 2–32 Zeichen');
export type GameId = z.infer<typeof gameIdSchema>;

/** Statusfarben aus den Design-Tokens (v2). */
export const STATUS_COLOR: Record<InstanceStatus, string> = {
  Online: '#3ee08f',
  Offline: '#8b98a8',
  Startet: '#f0b429',
  Stoppt: '#f0b429',
  Fehler: '#ff6b6b',
};

/** Ping-Farbskala aus den Design-Tokens: ≤55 ms grün, 56–90 ms gelb, >90 ms rot. */
export function pingColor(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '#8b98a8';
  if (ms <= 55) return '#3ee08f';
  if (ms <= 90) return '#f0b429';
  return '#ff6b6b';
}

/**
 * Fassung des Panels, wie sie in der Kopfzeile steht.
 *
 * Hier und nicht in den `package.json`: die drei Pakete sind `private` und
 * werden nie veröffentlicht, ihre Versionsfelder liest niemand. Eine Konstante
 * in `shared` erreicht Backend und Frontend ohne Build-Kniff — die Versionen in
 * den `package.json` werden mitgezogen, damit sie nicht widersprechen.
 */
export const PANEL_VERSION = 'v0.3.1';

/** Länge der Verlaufs-Ringpuffer — entspricht den 40 Messpunkten der Sparklines. */
export const HISTORY_LENGTH = 40;

/** Maximale Anzahl im Speicher gehaltener Logzeilen je Instanz. */
export const LOG_BUFFER_LENGTH = 140;

/** Maximale Anzahl Ereignisse je Instanz (Design: max. 9 sichtbar). */
export const EVENT_BUFFER_LENGTH = 50;

export const logLineSchema = z.object({
  /** HH:MM:SS */
  time: z.string(),
  level: logLevelSchema,
  text: z.string(),
});
export type LogLine = z.infer<typeof logLineSchema>;

export const eventSchema = z.object({
  /** HH:MM */
  time: z.string(),
  text: z.string(),
});
export type InstanceEvent = z.infer<typeof eventSchema>;
