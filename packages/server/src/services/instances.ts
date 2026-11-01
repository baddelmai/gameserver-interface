import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import {
  TOPIC,
  clockHms,
  defaultValues,
  formatBytes,
  getTemplate,
  validateSettings,
  type CreateInstanceRequest,
  type GameId,
  type PortSpec,
  type Instance,
  type InstanceStatus,
  type Job,
} from '@gsp/shared';
import type { Config } from '../config.js';
import type { InstanceRecord, Store } from '../db/store.js';
import { generateSecret } from '../auth/password.js';
import { getAdapter } from '../games/index.js';
import { dropRconConnection } from '../games/minecraft.js';
import { INSTANCE_LABEL, type Runtime } from '../runtime/types.js';
import type { BackupService } from './backups.js';
import type { Hub } from './hub.js';
import type { JobService } from './jobs.js';
import type { LogService } from './logs.js';
import type { MetricsService } from './metrics.js';
// Nur als Typ: der Vorlagendienst importiert umgekehrt `ValidationError` von hier.
import type { TemplateService } from './templates.js';
import { instanceRoot, slug, volumePath } from './paths.js';
import type { WorldService } from './world.js';
import { extract as extractZip, readEntries as readZipEntries } from './world-zip.js';

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

interface Transition {
  kind: 'starting' | 'stopping';
  since: number;
}

/**
 * Bündelt den Lebenszyklus einer Instanz: anlegen, starten, stoppen,
 * aktualisieren, löschen — und stellt die Sicht zusammen, die die UI anzeigt.
 */
export class InstanceService {
  private readonly transitions = new Map<string, Transition>();
  private readonly updating = new Set<string>();
  private readonly lastError = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly runtime: Runtime,
    private readonly logs: LogService,
    private readonly metrics: MetricsService,
    private readonly backups: BackupService,
    private readonly jobs: JobService,
    private readonly hub: Hub,
    private readonly templates: TemplateService,
    private readonly world: WorldService,
  ) {}

  list(): InstanceRecord[] {
    return this.store.listInstances();
  }

  get(id: string): InstanceRecord | null {
    return this.store.getInstance(id);
  }

  require(id: string): InstanceRecord {
    const instance = this.store.getInstance(id);
    if (!instance) throw new ValidationError('Instanz nicht gefunden');
    return instance;
  }

  /** Log-Verfolgung für alle bestehenden Instanzen aufnehmen. */
  attachAll(): void {
    for (const instance of this.list()) {
      this.logs.attach(instance);
    }
  }

  // --- Anlegen --------------------------------------------------------------

  async create(request: CreateInstanceRequest): Promise<{ instance: InstanceRecord; job: Job }> {
    const template = getTemplate(request.game);

    const settings = { ...defaultValues(template), ...request.settings };
    const errors = validateSettings(template, settings);
    if (errors.length > 0) {
      throw new ValidationError('Die Einstellungen sind unvollständig', errors);
    }

    const ports = this.resolvePorts(request.game, request.ports);
    const conflict = this.findPortConflict(request.game, ports);
    if (conflict) {
      throw new ValidationError(`Port ${conflict} ist bereits belegt`, [
        { field: 'ports', message: `Port ${conflict} ist bereits belegt` },
      ]);
    }

    const id = randomUUID().slice(0, 8);
    const containerName = `gsp-${slug(request.name)}-${id}`;
    const secrets: Record<string, string> = {};
    if (template.capabilities.console === 'rcon') {
      secrets.rconPassword = generateSecret(24);
    }

    const record: InstanceRecord = {
      id,
      game: request.game,
      name: request.name,
      tag: request.tag || template.defaultTag,
      containerName,
      containerId: null,
      ports,
      memoryMb: request.memoryMb,
      cpus: request.cpus,
      settings,
      secrets,
      backupCron: request.backupCron,
      backupKeepDays: request.backupKeepDays,
      peakPlayers: 0,
      lastBootSec: null,
      templateRev: null,
      createdAt: new Date().toISOString(),
    };

    this.store.insertInstance(record);
    this.store.addEvent(id, `Instanz „${record.name}“ angelegt`);

    const job = this.jobs.start('create', id, async (report) => {
      report(5, 'Image wird geladen');
      const image = `${template.image}:${record.tag}`;
      await this.runtime.pull(image, (progress) => {
        report(progress.percent === null ? null : 5 + progress.percent * 0.7, progress.message, {
          done: progress.currentBytes,
          total: progress.totalBytes,
        });
      });

      report(80, 'Container wird erstellt');
      await this.createContainer(record);

      report(95, 'Instanz wird gestartet');
      await this.start(id);
      this.hub.broadcast({ type: 'instances-changed' });
    });

    this.hub.broadcast({ type: 'instances-changed' });
    return { instance: record, job };
  }

  /** Legt Verzeichnisse an und erstellt den Container aus der Vorlage. */
  private async createContainer(record: InstanceRecord): Promise<void> {
    const template = getTemplate(record.game);
    this.completePorts(record);

    const binds = [];
    for (const volume of template.volumes) {
      // Angelegt wird lokal, eingehängt wird mit dem Pfad, unter dem der
      // Docker-Host dasselbe Verzeichnis sieht.
      const lokal = volumePath(this.config.volumeDir, record.id, volume.name);
      await mkdir(lokal, { recursive: true });
      binds.push({
        hostPath: volumePath(this.config.hostVolumeDir, record.id, volume.name),
        containerPath: volume.containerPath,
      });
    }

    const ctx = {
      hostPorts: record.ports,
      rconPassword: record.secrets.rconPassword,
      timezone: this.config.timezone,
    };
    const env = template.env(record.settings, ctx);
    // Startargumente hat nur, wessen Image sich nicht allein über Env einrichten
    // laesst — Terraria etwa kennt genau zwei Umgebungsvariablen.
    const args = template.args(record.settings, ctx);

    const containerId = await this.runtime.create({
      name: record.containerName,
      image: `${template.image}:${record.tag}`,
      env,
      ...(args.length > 0 ? { cmd: args } : {}),
      // Intern belegte Ports (RCON) werden nicht auf den Host veröffentlicht.
      ports: template.ports
        .filter((port) => !port.internalOnly)
        .map((port) => ({
          container: port.container,
          protocol: port.protocol,
          host: record.ports[port.name] ?? port.defaultHost,
          ...(port.count !== undefined ? { count: port.count } : {}),
        })),
      binds,
      memoryMb: record.memoryMb,
      cpus: record.cpus,
      labels: { [INSTANCE_LABEL]: record.id, game: record.game },
    });

    // Mit welchem Stand der Vorlage dieser Container gebaut wurde. Weicht die
    // Vorlage später ab, meldet das DTO `templateStale` und die Oberfläche bietet
    // „Neu aufbauen“ an — dieselbe Mechanik wie bei geänderten Einstellungen.
    this.store.updateInstance(record.id, {
      containerId,
      templateRev: this.templates.revOf(record.game),
    });
  }

  // --- Steuerung ------------------------------------------------------------

  async start(id: string): Promise<void> {
    const instance = this.require(id);
    this.transitions.set(id, { kind: 'starting', since: Date.now() });
    this.lastError.delete(id);
    this.logs.reset(id);
    try {
      // Fehlt der Container — extern entfernt oder nach einem Neustart im
      // Fake-Betrieb — wird er aus der gespeicherten Konfiguration neu erzeugt.
      const state = await this.runtime.inspect(instance.containerName);
      if (!state.exists) {
        await this.createContainer(instance);
        this.event(id, 'Container fehlte und wurde neu erstellt');
      }
      await this.runtime.start(instance.containerName);
      this.logs.attach(instance);
      this.event(id, 'Instanz gestartet');
    } catch (err) {
      this.transitions.delete(id);
      this.fail(id, err, 'Start fehlgeschlagen');
      throw err;
    }
  }

  async stop(id: string): Promise<void> {
    const instance = this.require(id);
    this.transitions.set(id, { kind: 'stopping', since: Date.now() });
    dropRconConnection(id);
    try {
      await this.runtime.stop(instance.containerName);
      this.logs.reset(id);
      this.event(id, 'Instanz gestoppt');
    } catch (err) {
      this.fail(id, err, 'Stoppen fehlgeschlagen');
      throw err;
    } finally {
      this.transitions.delete(id);
    }
  }

  async restart(id: string): Promise<void> {
    const instance = this.require(id);
    this.transitions.set(id, { kind: 'starting', since: Date.now() });
    dropRconConnection(id);
    this.logs.reset(id);
    try {
      await this.runtime.restart(instance.containerName);
      this.logs.attach(instance);
      this.event(id, 'Instanz neu gestartet');
    } catch (err) {
      this.transitions.delete(id);
      this.fail(id, err, 'Neustart fehlgeschlagen');
      throw err;
    }
  }

  /**
   * Lädt das Image neu und erzeugt den Container daraus. Die Weltdaten liegen
   * in Bind-Mounts und überleben das.
   */
  update(id: string): Job {
    const instance = this.require(id);
    const template = getTemplate(instance.game);
    this.updating.add(id);

    return this.jobs.start('update', id, async (report) => {
      try {
        report(5, 'Image wird geladen');
        await this.runtime.pull(`${template.image}:${instance.tag}`, (progress) => {
          report(progress.percent === null ? null : progress.percent * 0.8, progress.message, {
            done: progress.currentBytes,
            total: progress.totalBytes,
          });
        });
        report(85, 'Container wird neu erstellt');
        await this.recreate(id);
        this.event(id, 'Update eingespielt');
      } finally {
        this.updating.delete(id);
      }
    });
  }

  /** Container verwerfen und aus dem aktuellen Stand neu aufbauen. */
  async recreate(id: string): Promise<void> {
    const instance = this.require(id);
    const wasRunning = (await this.runtime.inspect(instance.containerName)).running;

    this.logs.detach(id);
    dropRconConnection(id);
    await this.runtime.stop(instance.containerName).catch(() => undefined);
    await this.runtime.remove(instance.containerName);
    await this.createContainer(instance);
    if (wasRunning) await this.start(id);
    this.hub.broadcast({ type: 'instances-changed' });
  }

  async updateSettings(
    id: string,
    settings: Record<string, string | number | boolean>,
    restart: boolean,
  ): Promise<void> {
    const instance = this.require(id);
    const template = getTemplate(instance.game);

    // Nicht editierbare Felder behalten ihren ursprünglichen Wert.
    const next = { ...instance.settings };
    for (const field of template.fields) {
      if (!field.editable) continue;
      if (settings[field.id] !== undefined) next[field.id] = settings[field.id]!;
    }

    const errors = validateSettings(template, next);
    if (errors.length > 0) throw new ValidationError('Die Einstellungen sind ungültig', errors);

    this.store.updateInstance(id, { settings: next });
    this.event(id, 'Serverkonfiguration gespeichert');

    // Die Umgebung eines Containers ist unveränderlich — für neue Werte muss er
    // neu erstellt werden.
    if (restart) await this.recreate(id);
    this.hub.broadcast({ type: 'instances-changed' });
  }

  async remove(id: string, deleteData: boolean): Promise<void> {
    const instance = this.require(id);
    this.logs.remove(id);
    dropRconConnection(id);
    this.metrics.remove(id);
    await this.runtime.remove(instance.containerName).catch(() => undefined);
    if (deleteData) {
      await rm(instanceRoot(this.config.volumeDir, id), { recursive: true, force: true });
    }
    this.store.deleteInstance(id);
    this.transitions.delete(id);
    this.hub.broadcast({ type: 'instances-changed' });
  }

  // --- Backups --------------------------------------------------------------

  backup(id: string, kind: 'auto' | 'manuell'): Job {
    const instance = this.require(id);
    const template = getTemplate(instance.game);

    return this.jobs.start('backup', id, async (report) => {
      const runCommand =
        template.capabilities.console === 'rcon'
          ? async (command: string) => {
              await getAdapter(instance.game).sendCommand(this.adapterContext(instance), command);
            }
          : undefined;

      const backup = await this.backups.create(instance, { kind, runCommand }, report);
      this.event(id, `Backup erstellt · ${backup.file} (${formatBytes(backup.sizeBytes)})`);
      this.hub.broadcast({ type: 'instances-changed' });
    });
  }

  restore(id: string, backupId: string): Job {
    const instance = this.require(id);
    return this.jobs.start('restore', id, async (report) => {
      const wasRunning = (await this.runtime.inspect(instance.containerName)).running;
      if (wasRunning) {
        report(10, 'Instanz wird gestoppt');
        await this.stop(id);
      }
      await this.backups.restore(instance, backupId, report);
      const backup = this.store.getBackup(id, backupId);
      this.event(id, `Wiederherstellung aus ${backup?.file ?? backupId} abgeschlossen`);
      if (wasRunning) {
        report(95, 'Instanz wird gestartet');
        await this.start(id);
      }
      this.hub.broadcast({ type: 'instances-changed' });
    });
  }

  /**
   * Ersetzt die Weltdaten durch eine hochgeladene Datei.
   *
   * Anders als `restore()` wird die Instanz **nicht** gestoppt und danach
   * gestartet: Der Austausch ist nur im gestoppten Zustand erlaubt, weil eine
   * laufende Engine ihre Welt im Speicher hält und beim nächsten Speichern über
   * die neue schreiben würde.
   */
  async replaceWorld(
    id: string,
    source: { path: string; fileName: string; ext: string },
    withBackup: boolean,
  ): Promise<Job> {
    const instance = this.require(id);
    if ((await this.runtime.inspect(instance.containerName)).running) {
      throw new ValidationError('Die Instanz läuft — für den Austausch muss sie gestoppt sein');
    }

    return this.jobs.start('welt', id, async (report) => {
      try {
        /*
         * Zwischen der Prüfung oben und dem Jobstart können Sekunden liegen —
         * der Zeitplan oder ein zweiter Browser-Tab könnte die Instanz
         * gestartet haben.
         */
        report(5, 'Instanz wird geprüft');
        if ((await this.runtime.inspect(instance.containerName)).running) {
          throw new Error('Die Instanz wurde zwischenzeitlich gestartet — Austausch abgebrochen');
        }

        if (withBackup) {
          report(15, 'Sicherung wird angelegt');
          // Ohne `runCommand`: Vorbefehle setzen einen laufenden Server voraus,
          // und der ist hier per Definition aus.
          const saved = await this.backups.create(instance, { kind: 'auto' });
          this.event(id, `Sicherung vor Weltaustausch · ${saved.file}`);
        }

        const result = await this.world.importWorld(
          instance,
          source,
          extractZip,
          (archive) => readZipEntries(archive, this.config.worldUploadMaxBytes),
          report,
        );

        this.event(id, `Weltdaten ersetzt · ${source.fileName} (${result.parts.join(', ')})`);
        this.hub.broadcast({ type: 'instances-changed' });
      } finally {
        await rm(source.path, { force: true });
      }
    });
  }

  // --- Zustand --------------------------------------------------------------

  adapterContext(instance: InstanceRecord) {
    return {
      instance,
      runtime: this.runtime,
      store: this.store,
      publicHost: this.config.publicHost,
      logPlayers: this.logs.players(instance.id),
    };
  }

  async statusOf(instance: InstanceRecord): Promise<{
    status: InstanceStatus;
    running: boolean;
    uptimeSec: number;
    error: string | null;
  }> {
    const state = await this.runtime.inspect(instance.containerName).catch(() => null);
    const transition = this.transitions.get(instance.id);
    const error = this.lastError.get(instance.id) ?? null;

    if (!state) {
      return { status: 'Fehler', running: false, uptimeSec: 0, error: 'Container-Backend nicht erreichbar' };
    }
    if (!state.exists) {
      return {
        status: 'Fehler',
        running: false,
        uptimeSec: 0,
        error: error ?? 'Container fehlt — „Starten“ erzeugt ihn aus der gespeicherten Konfiguration neu',
      };
    }

    const uptimeSec = state.startedAt
      ? Math.max(0, Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000))
      : 0;

    if (state.running) {
      // Der Übergang endet, sobald der Server seine Startmeldung geschrieben hat.
      if (this.logs.isReady(instance.id)) {
        // Genau in diesem Takt liegt der Übergang noch vor — danach ist er
        // gelöscht, die Dauer wird also einmal je Start geschrieben.
        if (transition?.kind === 'starting') {
          const dauerSek = Math.max(1, Math.round((Date.now() - transition.since) / 1000));
          this.store.updateInstance(instance.id, { lastBootSec: dauerSek });
          // Der Aufrufer hält den Datensatz in der Hand und baut gleich das DTO.
          instance.lastBootSec = dauerSek;
        }
        this.transitions.delete(instance.id);
        return { status: 'Online', running: true, uptimeSec, error: null };
      }
      return { status: 'Startet', running: true, uptimeSec, error: null };
    }

    if (transition?.kind === 'stopping') {
      return { status: 'Stoppt', running: false, uptimeSec: 0, error: null };
    }
    if (state.exitCode !== null && state.exitCode !== 0) {
      return {
        status: 'Fehler',
        running: false,
        uptimeSec: 0,
        error: error ?? `Container wurde mit Code ${state.exitCode} beendet`,
      };
    }
    return { status: 'Offline', running: false, uptimeSec: 0, error };
  }

  /** Stellt die vollständige Sicht für die UI zusammen. */
  async toDto(instance: InstanceRecord): Promise<Instance> {
    const template = getTemplate(instance.game);
    const state = await this.statusOf(instance);
    const snapshot = this.metrics.snapshot(instance);
    const backups = this.store.listBackups(instance.id);
    const latest = backups[0];

    const gamePort = instance.ports.game ?? instance.ports.query ?? 0;

    return {
      id: instance.id,
      game: instance.game,
      name: instance.name,
      version: snapshot.version ?? this.versionLabel(instance),
      address: `${this.config.publicHost}:${gamePort}`,
      provider: this.config.nodeLabel,
      status: state.status,
      running: state.running,
      updating: this.updating.has(instance.id),
      error: state.error,
      maxPlayers: this.maxPlayers(instance),
      cpus: instance.cpus,
      memoryMb: instance.memoryMb,
      capabilities: template.capabilities,
      metrics: { ...snapshot.metrics, uptimeSec: state.uptimeSec },
      players: state.running ? snapshot.players : [],
      bans: this.store.listBans(instance.id),
      facts: this.buildFacts(instance, snapshot.metrics.worldSizeBytes),
      settings: this.maskSecrets(instance),
      events: this.store.listEvents(instance.id),
      lastBackupAt: latest?.createdAt ?? null,
      lastBackupSizeBytes: latest?.sizeBytes ?? null,
      backupSchedule: describeCron(instance.backupCron, instance.backupKeepDays),
      backupCount: backups.length,
      updateNote: this.updating.has(instance.id) ? 'Update läuft' : 'Version ist aktuell',
      updateAvailable: false,
      lastBootSec: instance.lastBootSec,
      templateStale:
        instance.templateRev !== null && instance.templateRev !== this.templates.revOf(instance.game),
      createdAt: instance.createdAt,
    };
  }

  private versionLabel(instance: InstanceRecord): string {
    const settings = instance.settings;
    if (instance.game === 'minecraft') {
      return `${String(settings.type ?? 'Paper')} ${String(settings.version ?? '')}`.trim();
    }
    return instance.tag;
  }

  private maxPlayers(instance: InstanceRecord): number {
    const settings = instance.settings;
    const raw = settings.maxPlayers ?? settings.slotCount ?? 10;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 10;
  }

  /** Geheimnisse verlassen die API nie im Klartext. */
  private maskSecrets(instance: InstanceRecord): Record<string, string | number | boolean> {
    const template = getTemplate(instance.game);
    const out: Record<string, string | number | boolean> = {};
    for (const field of template.fields) {
      const value = instance.settings[field.id];
      if (value === undefined) continue;
      out[field.id] = field.secret && String(value).length > 0 ? '********' : value;
    }
    return out;
  }

  /** Inhalt des Blocks `// WELT & KONFIGURATION`. */
  private buildFacts(instance: InstanceRecord, worldSize: number): [string, string][] {
    const s = instance.settings;
    const facts: [string, string][] = [];

    if (instance.game === 'minecraft') {
      const seed = String(s.seed ?? '');
      facts.push(['Welt', seed ? `${String(s.levelName)} (Seed ${seed})` : String(s.levelName ?? '—')]);
      facts.push(['Weltgröße', formatBytes(worldSize)]);
      facts.push(['Modus', `${String(s.type ?? 'Paper')}, Schwierigkeit ${String(s.difficulty ?? 'normal')}`]);
      facts.push(['Whitelist', s.whitelist ? 'aktiv' : 'inaktiv']);
    } else if (instance.game === 'valheim') {
      facts.push(['Welt', String(s.worldName ?? '—')]);
      facts.push(['Weltgröße', formatBytes(worldSize)]);
      facts.push(['Modus', `${String(s.preset ?? 'normal')}${s.crossplay ? ', Crossplay aktiv' : ''}`]);
      facts.push(['Passwort', String(s.password ?? '') ? 'gesetzt' : 'nicht gesetzt']);
    } else {
      facts.push(['Welt', String(s.serverName ?? '—')]);
      facts.push(['Weltgröße', formatBytes(worldSize)]);
      facts.push(['Modus', String(s.gameSettingsPreset ?? 'Default')]);
      facts.push(['Admin-Rolle', String(s.adminPassword ?? '') ? 'gesetzt' : 'nicht gesetzt']);
    }

    facts.push(['Anbieter', this.config.nodeLabel]);
    facts.push(['Autom. Backup', describeCron(instance.backupCron, instance.backupKeepDays)]);
    facts.push(['Speicherort', instanceRoot(this.config.volumeDir, instance.id)]);
    return facts;
  }

  // --- Ports ----------------------------------------------------------------

  /** Ergänzt fehlende Ports aus der Vorlage. */
  resolvePorts(game: GameId, requested: { name: string; host: number }[]): Record<string, number> {
    const template = getTemplate(game);
    const ports: Record<string, number> = {};
    for (const spec of template.ports) {
      if (spec.internalOnly) continue;
      const match = requested.find((p) => p.name === spec.name);
      ports[spec.name] = match?.host ?? spec.defaultHost;
    }
    return ports;
  }

  /**
   * Erster Host-Port, der bereits von einer anderen Instanz belegt ist.
   * Bereiche zählen mit jedem ihrer Ports — Bedrocks UDP-Bereich ab 19140
   * belegt nicht nur 19140.
   */
  findPortConflict(game: GameId, ports: Record<string, number>, exceptInstanceId?: string): number | null {
    const used = this.usedHostPorts(exceptInstanceId);
    const specs = getTemplate(game).ports;
    for (const [name, first] of Object.entries(ports)) {
      for (const port of expand(first, specs.find((s) => s.name === name)?.count)) {
        if (used.has(port)) return port;
      }
    }
    return null;
  }

  /** Schlägt für eine Vorlage freie Host-Ports vor. */
  suggestPorts(game: GameId): Record<string, number> {
    return this.allocate(getTemplate(game).ports, this.usedHostPorts(), {});
  }

  /**
   * Trägt Ports nach, die die Vorlage inzwischen verlangt, die Instanz aber
   * nicht kennt — etwa den UDP-Bereich, den Bedrock seit NetherNet braucht.
   *
   * Ohne das bekäme jede bestehende Instanz beim Neuaufbau den Vorschlag der
   * Vorlage, und zwei Bedrock-Instanzen stritten sich um denselben Bereich.
   * Vorhandene Zuordnungen bleiben unangetastet: die Spieler kennen sie.
   */
  completePorts(record: InstanceRecord): void {
    const specs = getTemplate(record.game).ports.filter((s) => !s.internalOnly);
    if (specs.every((s) => record.ports[s.name] !== undefined)) return;

    const used = this.usedHostPorts(record.id);
    for (const [name, first] of Object.entries(record.ports)) {
      for (const port of expand(first, specs.find((s) => s.name === name)?.count)) used.add(port);
    }
    const ports = this.allocate(specs, used, record.ports);
    record.ports = ports;
    this.store.updateInstance(record.id, { ports });
  }

  /** Belegt je Port den ersten freien Platz ab dem Vorschlag der Vorlage — bei Bereichen den ganzen Bereich. */
  private allocate(
    specs: PortSpec[],
    used: Set<number>,
    existing: Record<string, number>,
  ): Record<string, number> {
    const ports: Record<string, number> = { ...existing };
    for (const spec of specs) {
      if (spec.internalOnly || ports[spec.name] !== undefined) continue;
      let candidate = spec.defaultHost;
      while (expand(candidate, spec.count).some((p) => used.has(p)) && candidate < 65_535) candidate += 1;
      for (const port of expand(candidate, spec.count)) used.add(port);
      ports[spec.name] = candidate;
    }
    return ports;
  }

  /** Alle Host-Ports der übrigen Instanzen, Bereiche ausgeschrieben. */
  private usedHostPorts(exceptInstanceId?: string): Set<number> {
    const used = new Set<number>();
    for (const instance of this.list()) {
      if (instance.id === exceptInstanceId) continue;
      // Eine Instanz, deren Vorlage gelöscht wurde, belegt ihre Ports trotzdem.
      let specs: PortSpec[] = [];
      try {
        specs = getTemplate(instance.game).ports;
      } catch {
        // Ohne Vorlage zählt jeder gespeicherte Port einzeln.
      }
      for (const [name, first] of Object.entries(instance.ports)) {
        for (const port of expand(first, specs.find((s) => s.name === name)?.count)) used.add(port);
      }
    }
    return used;
  }

  /**
   * Ein Ereignis von außerhalb des Lebenszyklus — etwa eine von Hand
   * bearbeitete Datei. Landet wie alle anderen in Protokoll, Log und Übersicht.
   */
  announce(id: string, text: string): void {
    this.event(id, text);
  }

  // --- Hilfen ---------------------------------------------------------------

  private event(id: string, text: string): void {
    this.store.addEvent(id, text);
    this.logs.append(id, { time: clockHms(), level: 'INFO', text });
    this.hub.publish(TOPIC.events, {
      type: 'event',
      instanceId: id,
      event: { time: clockHms().slice(0, 5), text },
    });
  }

  private fail(id: string, err: unknown, prefix: string): void {
    const message = `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
    this.lastError.set(id, message);
    this.store.addEvent(id, message);
    this.logs.append(id, { time: clockHms(), level: 'ERROR', text: message });
  }
}

/** Die Ports eines Eintrags: einer, oder bei `count` der ganze Bereich. */
function expand(first: number, count = 1): number[] {
  return Array.from({ length: count }, (_, i) => first + i);
}

/** `0 4 * * *` mit 7 Tagen wird zu `täglich 04:00 · 7 Tage`. */
export function describeCron(cron: string, keepDays: number): string {
  if (!cron.trim()) return 'deaktiviert';
  const parts = cron.trim().split(/\s+/);
  const retention = keepDays > 0 ? ` · ${keepDays} Tage` : '';
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    const minute = String(parts[0]).padStart(2, '0');
    const hour = String(parts[1]).padStart(2, '0');
    if (/^\d+$/.test(String(parts[0])) && /^\d+$/.test(String(parts[1]))) {
      return `täglich ${hour}:${minute}${retention}`;
    }
  }
  return `${cron}${retention}`;
}
