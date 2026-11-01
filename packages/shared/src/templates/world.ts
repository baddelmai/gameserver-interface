import type { FieldValues, GameTemplate, WorldDefinition, WorldPart } from '../schema/template.js';

/**
 * Auflösung der Weltangabe einer Vorlage gegen die Einstellungen einer Instanz.
 *
 * Liegt in `shared`, weil hier nur aus Vorlage und Formularwerten Container-Pfade
 * werden — ohne Dateisystem, ohne Host-Pfade. Das Übersetzen auf den Host macht
 * `toHostPath()` im Server. Dadurch ist der Teil, an dem ein Fehler Weltdaten
 * kostet, ohne Docker und ohne Platte prüfbar.
 */

/** Ein aufgelöster Teil der Welt. */
export interface WorldTargetPart {
  /** Container-Pfad, etwa `/data/welt_nether`. */
  containerPath: string;
  /** Name im Elternverzeichnis, etwa `welt_nether`. */
  fileName: string;
  suffix: string;
  type: 'dir' | 'file';
  required: boolean;
}

export interface WorldTarget {
  parent: string;
  /** Gemeinsamer Stamm, aufgelöst und geprüft. */
  base: string;
  parts: WorldTargetPart[];
  /** Die Welt selbst — nach Vereinbarung der erste Teil. */
  main: WorldTargetPart;
  markers: string[];
  accept: string[];
  /** Endungen, die wie `.zip` entpackt werden. */
  archives: string[];
}

/** Der Weltname taugt nicht als Pfadbestandteil. */
export class WorldNameError extends Error {}

/**
 * Der Stamm kommt bei fast allen Vorlagen aus einem Formularfeld und ist damit
 * Benutzereingabe. Nicht jede Vorlage prüft ihn — Valheims `worldName` hat nur
 * eine Längengrenze, keine Zeichenregel. Deshalb wird hier hart abgelehnt statt
 * gehofft; `isInside()` im Server fängt es ein zweites Mal ab.
 */
const FORBIDDEN = /[\\/:\0]/;
const MAX_LENGTH = 128;

function checkBase(base: string, origin: string): string {
  const value = base.trim();
  if (value === '') throw new WorldNameError(`${origin} ist leer`);
  if (value === '.' || value === '..') throw new WorldNameError(`${origin} darf nicht „${value}“ sein`);
  if (FORBIDDEN.test(value)) throw new WorldNameError(`${origin} darf keine Pfadanteile enthalten`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new WorldNameError(`${origin} enthält Steuerzeichen`);
  if (value.length > MAX_LENGTH) throw new WorldNameError(`${origin} ist länger als ${MAX_LENGTH} Zeichen`);
  return value;
}

/** Löst den Weltnamen auf. Wirft, wenn er als Pfadbestandteil untauglich ist. */
export function worldBase(world: WorldDefinition, values: FieldValues): string {
  if (world.name.kind === 'const') {
    return checkBase(world.name.value, 'Der Weltname der Vorlage');
  }
  const raw = values[world.name.field];
  if (raw === undefined) {
    throw new WorldNameError(`Das Feld „${world.name.field}“ fehlt in den Einstellungen`);
  }
  return checkBase(String(raw), `Das Feld „${world.name.field}“`);
}

function buildPart(parent: string, base: string, part: WorldPart): WorldTargetPart {
  const fileName = `${base}${part.suffix}`;
  return {
    containerPath: `${parent.replace(/\/+$/, '')}/${fileName}`,
    fileName,
    suffix: part.suffix,
    type: part.type,
    required: part.required,
  };
}

/**
 * Löst die Weltangabe einer Vorlage auf. `null`, wenn die Vorlage keine Welt
 * benennt — CS2, TF2 und Garry's Mod haben keine.
 */
export function worldTarget(template: GameTemplate, values: FieldValues): WorldTarget | null {
  const world = template.world;
  if (!world) return null;

  const base = worldBase(world, values);
  const parts = world.parts.map((part) => buildPart(world.parent, base, part));
  // `parts` hat laut Schema mindestens einen Eintrag; die Prüfung ist nur das
  // Netz darunter, weil `noUncheckedIndexedAccess` sie ohnehin verlangt.
  const main = parts[0];
  if (!main) throw new WorldNameError('Die Vorlage benennt keine Teile der Welt');

  return {
    parent: world.parent.replace(/\/+$/, ''),
    base,
    parts,
    main,
    markers: world.markers,
    accept: world.accept,
    archives: world.archives ?? [],
  };
}

/** Die Teile, die beim Einspielen zwingend im Archiv stehen müssen. */
export function requiredOnImport(target: WorldTarget): WorldTargetPart[] {
  return target.parts.filter((p) => p.required);
}
