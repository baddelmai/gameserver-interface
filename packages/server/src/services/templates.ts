import {
  BUILTIN_DEFINITIONS,
  compileTemplate,
  renderFakeLine,
  setTemplates,
  templateDefinitionSchema,
  type GameTemplate,
  type TemplateDefinition,
} from '@gsp/shared';
import type { Store } from '../db/store.js';
import { ValidationError } from './instances.js';

export interface TemplateInfo {
  definition: TemplateDefinition;
  /** Mitgeliefert — nur eine Beschriftung, keine Sperre: auch sie sind editierbar. */
  builtin: boolean;
  /** Stand der Vorlage; Instanzen merken sich ihn beim Erzeugen des Containers. */
  rev: string;
  /** Anzahl Instanzen, die darauf beruhen. */
  instances: number;
}

/**
 * Hält die Vorlagen in der Datenbank und die kompilierte Registry im Speicher
 * synchron. Nach jeder Änderung wird neu geladen — die Registry ist damit die
 * einzige Stelle, an der Dienste und Routen Vorlagen nachschlagen.
 */
export class TemplateService {
  constructor(private readonly store: Store) {}

  /**
   * Beim Start: fehlende mitgelieferte Vorlagen ergänzen, dann alles laden.
   *
   * Vorhandene werden **nicht** angefasst. Ein Panel-Update darf die Änderungen
   * des Betreibers nicht zurücksetzen — das wäre der teuerste Fehler in diesem
   * Entwurf, weil er lautlos passiert und erst beim nächsten Containerbau auffällt.
   */
  seedAndLoad(): { seeded: string[]; backfilled: string[]; migrated: string[] } {
    const now = new Date().toISOString();
    const seeded: string[] = [];

    for (const definition of BUILTIN_DEFINITIONS) {
      const inserted = this.store.insertTemplateIfMissing(
        definition.id,
        JSON.stringify(definition),
        true,
        now,
      );
      if (inserted) seeded.push(definition.id);
    }

    const backfilled = this.backfillWorld();
    const migrated = this.migrateValheimWorldFormat();
    this.reload();
    return { seeded, backfilled, migrated };
  }

  /**
   * Ergänzt bestehenden Zeilen den Weltblock.
   *
   * Nötig, weil Seeding vorhandene Vorlagen nie überschreibt — ohne diesen
   * Schritt hätte auf jeder bestehenden Installation keine Vorlage ein `world`,
   * und der Welt-Reiter erschiene einfach nicht. Ohne Fehlermeldung, ohne
   * Hinweis, für immer.
   *
   * Die Zusage des Seedings bleibt trotzdem gewahrt: ergänzt wird **nur** der
   * eine fehlende Schlüssel, und nur bei mitgelieferten Vorlagen. Ein Betreiber
   * kann `world` bis hierher nicht selbst gesetzt haben — das Feld gab es nicht.
   *
   * `updated_at` bleibt stehen. Sonst meldeten alle bestehenden Instanzen
   * „Vorlage geändert“ und die Oberfläche böte grundlos „Neu aufbauen“ an — der
   * Container ändert sich durch `world` aber nicht.
   */
  private backfillWorld(): string[] {
    const backfilled: string[] = [];
    for (const definition of BUILTIN_DEFINITIONS) {
      if (!definition.world) continue;
      const row = this.store.getTemplateRow(definition.id);
      if (!row) continue;

      let stored: Record<string, unknown>;
      try {
        stored = JSON.parse(row.definition) as Record<string, unknown>;
      } catch {
        // Eine kaputte Zeile darf den Start nicht verhindern; `reload()` lässt
        // sie ohnehin aus.
        continue;
      }
      if ('world' in stored) continue;

      stored.world = definition.world;
      this.store.upsertTemplate(
        definition.id,
        JSON.stringify(stored),
        row.builtin === 1,
        row.updated_at,
      );
      backfilled.push(definition.id);
    }
    return backfilled;
  }

  /**
   * Hebt eine bestehende Valheim-Zeile vom alten `.fwl`/`.db`-Dateipaar auf das
   * seit Valheim 1.0 gültige Weltverzeichnis.
   *
   * Ein reines `backfillWorld()` reicht hier nicht: Das Feld `world` gab es bei
   * Valheim schon vorher, nur mit anderer Form — Seeding fasst es deshalb nie
   * an, und jede vor diesem Umbau angelegte Installation bliebe für immer beim
   * alten Format stehen. Der Weltaustausch fände nie das neue Verzeichnis, weil
   * er nach `<Weltname>.fwl` sucht statt nach `<Weltname>/`.
   *
   * Erkannt wird die alte Form eng am `.fwl`-Suffix — dem einzigen Teil, den
   * eine eigene Vorlage kaum zufällig träfe. Ein Betreiber, der `world` bei
   * Valheim selbst verändert hat, hätte damit kaum dasselbe Suffix gewählt;
   * träfe es doch zu, überschreibt die Migration nur mitgelieferte Zeilen
   * (`builtin`), nie eine, die als eigene Vorlage gespeichert wurde.
   */
  private migrateValheimWorldFormat(): string[] {
    const definition = BUILTIN_DEFINITIONS.find((d) => d.id === 'valheim');
    if (!definition?.world) return [];

    const row = this.store.getTemplateRow('valheim');
    if (!row || row.builtin !== 1) return [];

    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(row.definition) as Record<string, unknown>;
    } catch {
      return [];
    }

    const world = stored.world as { parts?: unknown[] } | undefined;
    const isOldShape = Array.isArray(world?.parts) && world.parts.some(
      (part) => typeof part === 'object' && part !== null && (part as { suffix?: unknown }).suffix === '.fwl',
    );
    if (!isOldShape) return [];

    stored.world = definition.world;
    this.store.upsertTemplate('valheim', JSON.stringify(stored), true, row.updated_at);
    return ['valheim'];
  }

  /** Liest alle Vorlagen aus der Datenbank und ersetzt die Registry. */
  reload(): void {
    const templates: GameTemplate[] = [];
    for (const row of this.store.listTemplateRows()) {
      const parsed = this.parse(row.definition, row.id);
      if (!parsed) continue;
      templates.push(compileTemplate(parsed));
    }
    setTemplates(templates);
  }

  list(): TemplateInfo[] {
    const infos: TemplateInfo[] = [];
    for (const row of this.store.listTemplateRows()) {
      const definition = this.parse(row.definition, row.id);
      if (!definition) continue;
      infos.push({
        definition,
        builtin: row.builtin === 1,
        rev: row.updated_at,
        instances: this.store.countInstancesByGame(row.id),
      });
    }
    return infos;
  }

  get(id: string): TemplateInfo | null {
    const row = this.store.getTemplateRow(id);
    if (!row) return null;
    const definition = this.parse(row.definition, row.id);
    if (!definition) return null;
    return {
      definition,
      builtin: row.builtin === 1,
      rev: row.updated_at,
      instances: this.store.countInstancesByGame(row.id),
    };
  }

  /** Stand der Vorlage, wie er in `instances.template_rev` landet. */
  revOf(id: string): string | null {
    return this.store.getTemplateRow(id)?.updated_at ?? null;
  }

  create(input: unknown): TemplateDefinition {
    const definition = this.validate(input);
    if (this.store.getTemplateRow(definition.id)) {
      throw new ValidationError(`Es gibt bereits eine Vorlage mit der Kennung „${definition.id}“`, [
        { field: 'id', message: 'Kennung ist bereits vergeben' },
      ]);
    }
    this.store.upsertTemplate(definition.id, JSON.stringify(definition), false, new Date().toISOString());
    this.reload();
    return definition;
  }

  update(id: string, input: unknown): TemplateDefinition {
    const existing = this.store.getTemplateRow(id);
    if (!existing) throw new ValidationError('Vorlage nicht gefunden');

    const definition = this.validate(input);
    if (definition.id !== id) {
      // Die Kennung steckt in Container-Labels und Instanzdatensätzen; ein
      // Umbenennen wäre eine Migration, kein Formularfeld.
      throw new ValidationError('Die Kennung einer Vorlage lässt sich nicht ändern', [
        { field: 'id', message: 'Kennung ist unveränderlich' },
      ]);
    }

    this.store.upsertTemplate(id, JSON.stringify(definition), existing.builtin === 1, new Date().toISOString());
    this.reload();
    return definition;
  }

  remove(id: string): void {
    const existing = this.store.getTemplateRow(id);
    if (!existing) throw new ValidationError('Vorlage nicht gefunden');

    const count = this.store.countInstancesByGame(id);
    if (count > 0) {
      throw new ValidationError(
        `Die Vorlage wird von ${count} Instanz${count === 1 ? '' : 'en'} genutzt und kann nicht gelöscht werden`,
      );
    }

    this.store.deleteTemplate(id);
    this.reload();
  }

  /**
   * Prüft die Eingabe gegen das Schema und darüber hinaus die Zusagen, die
   * Dienste an anderer Stelle voraussetzen. Ohne diese Prüfungen ließe sich
   * eine Vorlage speichern, die erst beim Anlegen einer Instanz auffällt.
   */
  private validate(input: unknown): TemplateDefinition {
    const parsed = templateDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        'Die Vorlage ist unvollständig',
        parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    const definition = parsed.data;
    const errors: { field: string; message: string }[] = [];

    const fieldIds = new Set(definition.fields.map((f) => f.id));
    const portNames = new Set(definition.ports.map((p) => p.name));

    if (fieldIds.size !== definition.fields.length) {
      errors.push({ field: 'fields', message: 'Feldkennungen müssen eindeutig sein' });
    }
    if (portNames.size !== definition.ports.length) {
      errors.push({ field: 'ports', message: 'Portnamen müssen eindeutig sein' });
    }

    // Verweise der Env-Abbildung müssen ins Leere zeigen können, sonst stünde
    // die Variable später einfach leer im Container.
    for (const [index, mapping] of definition.env.entries()) {
      if (mapping.source.kind === 'field' && !fieldIds.has(mapping.source.field)) {
        errors.push({ field: `env.${index}`, message: `Unbekanntes Feld „${mapping.source.field}“` });
      }
      if (mapping.source.kind === 'port' && !portNames.has(mapping.source.port)) {
        errors.push({ field: `env.${index}`, message: `Unbekannter Port „${mapping.source.port}“` });
      }
      if (mapping.source.kind === 'rconPassword' && definition.capabilities.console !== 'rcon') {
        errors.push({
          field: `env.${index}`,
          message: 'Ein RCON-Passwort gibt es nur bei Vorlagen mit console: rcon',
        });
      }
    }

    for (const [index, regel] of definition.validations.entries()) {
      if (!fieldIds.has(regel.field)) {
        errors.push({ field: `validations.${index}`, message: `Unbekanntes Feld „${regel.field}“` });
      }
    }

    // Backup-Pfade müssen in einem Volume liegen, sonst sichert das Panel nichts.
    for (const [index, pfad] of definition.backup.paths.entries()) {
      const inVolume = definition.volumes.some((v) => pfad === v.containerPath || pfad.startsWith(`${v.containerPath}/`));
      if (!inVolume) {
        errors.push({
          field: `backup.paths.${index}`,
          message: `„${pfad}“ liegt in keinem der deklarierten Volumes`,
        });
      }
    }
    if (definition.backup.preCommands.length > 0 && definition.capabilities.console !== 'rcon') {
      errors.push({
        field: 'backup.preCommands',
        message: 'Vorbefehle brauchen eine Konsole (console: rcon)',
      });
    }

    /*
     * Weltdaten. Was hier durchrutscht, fällt erst beim ersten Austausch auf —
     * im ungünstigsten Fall, nachdem die bisherige Welt schon weg war.
     */
    const world = definition.world;
    if (world) {
      const inVolume = definition.volumes.some(
        (v) => world.parent === v.containerPath || world.parent.startsWith(`${v.containerPath}/`),
      );
      if (!inVolume) {
        errors.push({
          field: 'world.parent',
          message: `„${world.parent}“ liegt in keinem der deklarierten Volumes`,
        });
      }

      /*
       * Vor dem Überschreiben legt das Panel eine Sicherung an, und die sichert
       * `backup.paths`. Läge die Welt außerhalb, wäre die Sicherung wertlos und
       * der Austausch unumkehrbar — die einzige Prüfung hier, die eine Vorlage
       * aus Sicherheitsgründen ablehnt und nicht der Form wegen.
       *
       * Bei einem festen Namen wird der ganze Weltpfad geprüft: Enshrouded
       * sichert `/opt/enshrouded/savegame`, während `parent` das Volume darüber
       * ist. Bei einem Namen aus einem Feld steht der Pfad erst zur Laufzeit
       * fest, dort muss `parent` selbst abgedeckt sein.
       */
      const checkPath =
        world.name.kind === 'const'
          ? `${world.parent.replace(/\/+$/, '')}/${world.name.value}`
          : world.parent;
      const gesichert = definition.backup.paths.some(
        (p) => checkPath === p || checkPath.startsWith(`${p}/`),
      );
      if (!gesichert) {
        errors.push({
          field: 'world.parent',
          message:
            'Die Weltdaten müssen von den Backup-Pfaden abgedeckt sein — sonst gäbe es vor dem Austausch keine Sicherung',
        });
      }

      if (world.name.kind === 'field' && !fieldIds.has(world.name.field)) {
        errors.push({ field: 'world.name', message: `Unbekanntes Feld „${world.name.field}“` });
      }
      if (world.name.kind === 'const' && /[\\/:]/.test(world.name.value)) {
        errors.push({ field: 'world.name', message: 'Der Weltname darf keine Pfadanteile enthalten' });
      }

      // Der erste Teil ist die Welt selbst; ohne ihn gäbe es nichts zu tauschen.
      if (world.parts[0]?.required !== true) {
        errors.push({ field: 'world.parts.0', message: 'Der erste Teil ist die Welt selbst und muss erforderlich sein' });
      }
      const suffixes = new Set(world.parts.map((t) => t.suffix));
      if (suffixes.size !== world.parts.length) {
        errors.push({ field: 'world.parts', message: 'Die Endungen der Teile müssen eindeutig sein' });
      }
      for (const [index, part] of world.parts.entries()) {
        if (/[\\/:]/.test(part.suffix)) {
          errors.push({ field: `world.parts.${index}`, message: 'Eine Endung darf keine Pfadanteile enthalten' });
        }
      }
      for (const [index, ext] of world.accept.entries()) {
        if (!ext.startsWith('.')) {
          errors.push({ field: `world.accept.${index}`, message: 'Endungen beginnen mit einem Punkt, etwa .wld' });
        }
      }
    }

    if (definition.capabilities.mods === 'none' && definition.modsPath) {
      errors.push({ field: 'modsPath', message: 'Ohne Mod-Unterstützung gibt es kein Mod-Verzeichnis' });
    }
    if (definition.capabilities.mods !== 'none' && !definition.modsPath) {
      errors.push({ field: 'modsPath', message: 'Mod-Unterstützung braucht ein Mod-Verzeichnis' });
    }
    if (definition.capabilities.players === 'a2s' && !definition.adapter.queryPortName) {
      errors.push({
        field: 'adapter.queryPortName',
        message: 'Für die Steam-Abfrage muss der Abfrageport benannt sein',
      });
    }
    if (definition.adapter.queryPortName && !portNames.has(definition.adapter.queryPortName)) {
      errors.push({ field: 'adapter.queryPortName', message: 'Unbekannter Port' });
    }
    if (definition.adapter.maxPlayersField && !fieldIds.has(definition.adapter.maxPlayersField)) {
      errors.push({ field: 'adapter.maxPlayersField', message: 'Unbekanntes Feld' });
    }

    // Konsole und Spielerliste sind unabhängig, beide brauchen aber ihren Port.
    if (definition.capabilities.console === 'rcon' || definition.capabilities.players === 'rcon') {
      const name = definition.adapter.rconPortName ?? 'rcon';
      if (!portNames.has(name)) {
        errors.push({
          field: 'adapter.rconPortName',
          message: `Für RCON muss ein Port „${name}“ deklariert sein`,
        });
      }
    }
    // Kick und Bann laufen ausschließlich über RCON — ohne Konsole gäbe die
    // Oberfläche Knöpfe aus, die nur `UnsupportedError` liefern könnten.
    if (definition.capabilities.moderation && definition.capabilities.console !== 'rcon') {
      errors.push({
        field: 'capabilities.moderation',
        message: 'Kick und Bann brauchen eine Konsole (console: rcon)',
      });
    }
    if (definition.adapter.rconListFormat && definition.capabilities.players !== 'rcon') {
      errors.push({
        field: 'adapter.rconListFormat',
        message: 'Ein Listenformat ergibt nur bei players: rcon einen Sinn',
      });
    }

    // Muster werden gegen jede Logzeile ausgeführt. Ein unübersetzbares Muster
    // soll beim Speichern auffallen, nicht im laufenden Betrieb.
    for (const [name, spec] of [
      ['logPatterns.join', definition.logPatterns.join],
      ['logPatterns.ready', definition.logPatterns.ready],
      ['logPatterns.leave', definition.logPatterns.leave],
      ['logPatterns.clean', definition.logPatterns.clean?.pattern],
    ] as const) {
      if (!spec) continue;
      if (spec.source.length > 400) {
        errors.push({ field: name, message: 'Muster ist zu lang (höchstens 400 Zeichen)' });
        continue;
      }
      // Verschachtelte Quantoren sind die übliche Ursache katastrophaler
      // Laufzeiten; Node kennt keine RegExp-Zeitgrenze, mit der man sie auffangen könnte.
      if (/(\([^)]*[+*][^)]*\)|\[[^\]]*\][+*])\s*[+*]/.test(spec.source)) {
        errors.push({
          field: name,
          message: 'Verschachtelte Wiederholungen sind nicht erlaubt — sie können das Panel blockieren',
        });
        continue;
      }
      try {
        new RegExp(spec.source, spec.flags);
      } catch (err) {
        errors.push({ field: name, message: err instanceof Error ? err.message : 'Ungültiges Muster' });
      }
    }

    /*
     * Wenn Beispielzeilen angegeben sind, müssen sie zu den Mustern derselben
     * Vorlage passen. Sonst erkennt der Log-Parser im Betrieb ohne Docker
     * nichts — die Instanz bliebe für immer auf „Startet“ stehen, und der
     * Fehler fiele erst beim Ausprobieren auf. Für die mitgelieferten Vorlagen
     * prüft das ein Test; hier gilt dasselbe für selbst angelegte.
     */
    if (definition.fakeLog && errors.length === 0) {
      const muster = compileTemplate(definition).logPatterns;
      const beitritt = renderFakeLine(definition.fakeLog, 'join', 'Testspieler', 42);
      if (muster.join.exec(beitritt)?.[1] !== 'Testspieler') {
        errors.push({
          field: 'fakeLog.join',
          message: `„${beitritt}“ passt nicht zum Beitrittsmuster — Gruppe 1 muss der Spielername sein`,
        });
      }
      const start = renderFakeLine(definition.fakeLog, 'ready', '', 1200);
      if (!muster.ready.test(start)) {
        errors.push({
          field: 'fakeLog.ready',
          message: `„${start}“ passt nicht zum Startmuster — die Instanz käme nie über „Startet“ hinaus`,
        });
      }
      if (muster.leave) {
        const abgang = renderFakeLine(definition.fakeLog, 'leave', 'Testspieler', 9001);
        if (muster.leave.exec(abgang)?.[1] !== 'Testspieler') {
          errors.push({
            field: 'fakeLog.leave',
            message: `„${abgang}“ passt nicht zum Abgangsmuster`,
          });
        }
      }
    }

    if (errors.length > 0) throw new ValidationError('Die Vorlage ist nicht schlüssig', errors);
    return definition;
  }

  private parse(json: string, id: string): TemplateDefinition | null {
    try {
      const parsed = templateDefinitionSchema.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      // Eine kaputte Zeile darf nicht den Start verhindern; die betroffene
      // Vorlage fehlt dann in der Registry und ihre Instanzen melden 404.
      void id;
      return null;
    }
  }
}
