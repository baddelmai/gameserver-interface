import { z } from 'zod';
import type { TemplateDefinition } from '../schema/template-definition.js';
import type {
  FieldSpec,
  FieldValues,
  GameTemplate,
  TemplateDescriptor,
} from '../schema/template.js';
import { applyValidations, compileTemplate } from './compile.js';
import { minecraftDefinition } from './minecraft.js';
import { valheimDefinition } from './valheim.js';
import { enshroudedDefinition } from './enshrouded.js';
import { minecraftBedrockDefinition } from './minecraft-bedrock.js';
import { factorioDefinition } from './factorio.js';
import { terrariaDefinition } from './terraria.js';
import { luantiDefinition } from './luanti.js';
import { palworldDefinition } from './palworld.js';
import { cs2Definition } from './cs2.js';
import { tf2Definition } from './tf2.js';
import { garrysmodDefinition } from './garrysmod.js';
import { rustDefinition } from './rust.js';
import { arkDefinition } from './ark.js';
import { sevenDaysToDieDefinition } from './sevendaystodie.js';
import { zomboidDefinition } from './zomboid.js';
import { vrisingDefinition } from './vrising.js';
import { satisfactoryDefinition } from './satisfactory.js';
import { dstDefinition } from './dst.js';
import { coreKeeperDefinition } from './corekeeper.js';
import { barotraumaDefinition } from './barotrauma.js';

/**
 * Die mitgelieferten Vorlagen. Sie sind **Startbestand**, kein Laufzeitpfad:
 * beim ersten Start schreibt der Server sie in die Datenbank, danach ist die
 * Datenbank die Quelle. Wer sie hier ändert, ändert nur, was eine frische
 * Installation bekommt — bestehende werden nie überschrieben.
 */
export const BUILTIN_DEFINITIONS: TemplateDefinition[] = [
  minecraftDefinition,
  minecraftBedrockDefinition,
  valheimDefinition,
  enshroudedDefinition,
  factorioDefinition,
  terrariaDefinition,
  luantiDefinition,
  palworldDefinition,
  cs2Definition,
  tf2Definition,
  garrysmodDefinition,
  rustDefinition,
  arkDefinition,
  sevenDaysToDieDefinition,
  zomboidDefinition,
  vrisingDefinition,
  satisfactoryDefinition,
  dstDefinition,
  coreKeeperDefinition,
  barotraumaDefinition,
];

/**
 * Die aktuell geladenen Vorlagen. Früher eine Konstante; jetzt füllt der Server
 * sie beim Start aus der Datenbank und nach jeder Bearbeitung neu.
 *
 * Bewusst ein Modul-Singleton: die Alternative wäre, eine Registry durch jeden
 * Dienst und jede Route zu reichen, obwohl es nie eine zweite gibt.
 */
let registry = new Map<string, GameTemplate>();

export class UnknownTemplateError extends Error {
  constructor(readonly game: string) {
    super(`Unbekannte Vorlage „${game}“`);
    this.name = 'UnknownTemplateError';
  }
}

/** Ersetzt den geladenen Bestand. */
export function setTemplates(templates: GameTemplate[]): void {
  registry = new Map(templates.map((template) => [template.id, template]));
}

/** Lädt die eingebauten Vorlagen — für Tests und als Notnagel ohne Datenbank. */
export function loadBuiltinTemplates(): void {
  setTemplates(BUILTIN_DEFINITIONS.map(compileTemplate));
}

/**
 * Wirft, wenn die Vorlage fehlt. Früher konnte das nicht passieren, weil
 * `GameId` ein Enum war; mit anlegbaren Vorlagen ist eine Instanz denkbar, deren
 * Vorlage entfernt wurde. Die Routen beantworten das mit 404.
 */
export function getTemplate(game: string): GameTemplate {
  const template = registry.get(game);
  if (!template) throw new UnknownTemplateError(game);
  return template;
}

/** `null` statt Ausnahme — für Stellen, die einen fehlenden Eintrag verkraften. */
export function findTemplate(game: string): GameTemplate | null {
  return registry.get(game) ?? null;
}

export function listTemplates(): GameTemplate[] {
  return [...registry.values()];
}

/** Reduziert eine Vorlage auf den JSON-serialisierbaren Teil für die API. */
export function toDescriptor(template: GameTemplate): TemplateDescriptor {
  // Ausdrücklich aufgezählt statt „alles außer den Funktionen“: sonst wandert
  // jedes neue interne Feld stillschweigend in die API-Antwort.
  return {
    id: template.id,
    label: template.label,
    summary: template.summary,
    image: template.image,
    defaultTag: template.defaultTag,
    ports: template.ports,
    volumes: template.volumes,
    fields: template.fields,
    capabilities: template.capabilities,
    defaultMemoryMb: template.defaultMemoryMb,
    defaultCpus: template.defaultCpus,
    notes: template.notes,
    modExtensions: template.modExtensions,
    ...(template.world !== undefined ? { world: template.world } : {}),
  };
}

/** Vorbelegung eines Formulars aus den Feld-Defaults. */
export function defaultValues(template: GameTemplate): FieldValues {
  const values: FieldValues = {};
  for (const field of template.fields) {
    if (field.default !== undefined) values[field.id] = field.default;
    else if (field.type === 'boolean') values[field.id] = false;
    else if (field.type === 'number') values[field.id] = field.min ?? 0;
    else values[field.id] = '';
  }
  return values;
}

/** Baut aus den Feld-Specs ein Zod-Schema, das Frontend und Backend teilen. */
export function settingsSchema(template: GameTemplate): z.ZodType<FieldValues> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of template.fields) {
    shape[field.id] = fieldSchema(field);
  }
  return z.object(shape).passthrough() as unknown as z.ZodType<FieldValues>;
}

function fieldSchema(field: FieldSpec): z.ZodTypeAny {
  switch (field.type) {
    case 'boolean':
      return z.boolean();
    case 'number': {
      let schema = z.number();
      if (field.min !== undefined) schema = schema.min(field.min, `Mindestens ${field.min}`);
      if (field.max !== undefined) schema = schema.max(field.max, `Höchstens ${field.max}`);
      return schema;
    }
    case 'select':
      return z.enum((field.options ?? []).map((o) => o.value) as [string, ...string[]]);
    case 'text':
    case 'password': {
      let schema = z.string();
      if (field.maxLength !== undefined) {
        schema = schema.max(field.maxLength, `Höchstens ${field.maxLength} Zeichen`);
      }
      return field.required ? schema.min(1, `${field.label} ist erforderlich`) : schema;
    }
  }
}

/**
 * Prüft die Einstellungen gegen die Feld-Specs und die Regeln der Vorlage.
 * Die spielspezifischen Sonderfälle standen früher als `if (template.id === …)`
 * hier im Code; jetzt bringt jede Vorlage ihre Regeln selbst mit.
 */
export function validateSettings(
  template: GameTemplate,
  values: FieldValues,
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const parsed = settingsSchema(template).safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ field: String(issue.path[0] ?? ''), message: issue.message });
    }
  }

  errors.push(...applyValidations(template.definition.validations, values));
  return errors;
}

export { compileTemplate, applyValidations, portRange } from './compile.js';
export { renderFakeLine, DEFAULT_FAKE_LOG } from './fakelog.js';
export {
  worldTarget,
  worldBase,
  requiredOnImport,
  WorldNameError,
  type WorldTarget,
  type WorldTargetPart,
} from './world.js';
export { minecraftDefinition } from './minecraft.js';
export { valheimDefinition } from './valheim.js';
export { enshroudedDefinition } from './enshrouded.js';
export { minecraftBedrockDefinition } from './minecraft-bedrock.js';
export { factorioDefinition } from './factorio.js';
export { terrariaDefinition } from './terraria.js';
export { luantiDefinition } from './luanti.js';
export { palworldDefinition } from './palworld.js';
export { cs2Definition } from './cs2.js';
export { tf2Definition } from './tf2.js';
export { garrysmodDefinition } from './garrysmod.js';
export { rustDefinition } from './rust.js';
export { arkDefinition } from './ark.js';
export { sevenDaysToDieDefinition } from './sevendaystodie.js';
export { zomboidDefinition } from './zomboid.js';
export { vrisingDefinition } from './vrising.js';
export { satisfactoryDefinition } from './satisfactory.js';
export { dstDefinition } from './dst.js';
export { coreKeeperDefinition } from './corekeeper.js';
export { barotraumaDefinition } from './barotrauma.js';
