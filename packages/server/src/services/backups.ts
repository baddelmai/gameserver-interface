import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { create as tarCreate, extract as tarExtract, list as tarList } from 'tar';
import { backupStamp, getTemplate, type Backup } from '@gsp/shared';
import type { InstanceRecord, Store } from '../db/store.js';
import { instanceRoot, isInside, slug, toHostPath } from './paths.js';

/** Ein hochgeladenes Archiv taugt nicht als Backup dieser Instanz — Benutzereingabe, kein Serverfehler. */
export class BackupError extends Error {}

const ARCHIVE_SUFFIX = '.tar.zst';

export interface BackupOptions {
  kind: 'auto' | 'manuell';
  /** Vor dem Sichern abzusetzende Konsolenbefehle. */
  runCommand?: (command: string) => Promise<void>;
}

/**
 * Sichert die Weltdaten als `.tar.zst`. Die zstd-Kompression stammt aus
 * `node:zlib` (Node ≥ 22.15) — es wird kein externes Binary benötigt, und die
 * Dateinamen entsprechen dem Muster aus dem Design.
 */
export class BackupService {
  constructor(
    private readonly store: Store,
    private readonly volumeDir: string,
    private readonly backupDir: string,
  ) {}

  private dirFor(instanceId: string): string {
    return join(this.backupDir, instanceId);
  }

  fileFor(instanceId: string, file: string): string | null {
    const dir = this.dirFor(instanceId);
    const path = join(dir, file);
    // `file` stammt aus der Datenbank, wird aber trotzdem geprüft.
    return isInside(dir, path) ? path : null;
  }

  async create(
    instance: InstanceRecord,
    options: BackupOptions,
    report?: (progress: number | null, message: string) => void,
  ): Promise<Backup> {
    const template = getTemplate(instance.game);
    const root = instanceRoot(this.volumeDir, instance.id);

    // Container-Pfade der Vorlage auf Host-Pfade abbilden.
    const targets: string[] = [];
    for (const containerPath of template.backup.paths) {
      const host = toHostPath(this.volumeDir, instance, containerPath);
      if (host) targets.push(host);
    }
    if (targets.length === 0) {
      throw new Error('Die Vorlage benennt keine sicherbaren Pfade');
    }

    const dir = this.dirFor(instance.id);
    await mkdir(dir, { recursive: true });
    const file = `${slug(instance.name)}-${backupStamp()}-${options.kind}.tar.zst`;
    const path = join(dir, file);

    const pre = template.backup.preCommands ?? [];
    const post = template.backup.postCommands ?? [];

    if (options.runCommand && pre.length > 0) {
      report?.(10, 'Schreibvorgänge werden angehalten');
      for (const command of pre) {
        await options.runCommand(command).catch(() => undefined);
      }
    }

    try {
      report?.(30, 'Archiv wird geschrieben');
      // Relative Einträge im Archiv, damit sich das Backup unabhängig vom
      // Instanzverzeichnis wiederherstellen lässt.
      const entries = targets
        .map((target) => relative(root, target))
        .filter((entry) => entry.length > 0 && !entry.startsWith('..'));

      await pipeline(
        tarCreate({ cwd: root, portable: true }, entries),
        createZstdCompress(),
        createWriteStream(path),
      );
    } finally {
      if (options.runCommand && post.length > 0) {
        // Auch nach einem Fehler muss das Speichern wieder freigegeben werden.
        for (const command of post) {
          await options.runCommand(command).catch(() => undefined);
        }
      }
    }

    report?.(90, 'Archiv wird erfasst');
    const size = (await stat(path)).size;
    const backup: Backup = {
      id: randomUUID(),
      file,
      sizeBytes: size,
      kind: options.kind,
      createdAt: new Date().toISOString(),
    };
    this.store.addBackup(instance.id, backup);
    await this.applyRetention(instance);
    return backup;
  }

  /**
   * Stellt ein Archiv wieder her. Der Aufrufer muss die Instanz vorher stoppen —
   * das Entpacken über laufende Weltdateien führt sonst zu Datenverlust.
   */
  async restore(
    instance: InstanceRecord,
    backupId: string,
    report?: (progress: number | null, message: string) => void,
  ): Promise<void> {
    const backup = this.store.getBackup(instance.id, backupId);
    if (!backup) throw new Error('Backup nicht gefunden');
    const path = this.fileFor(instance.id, backup.file);
    if (!path) throw new Error('Ungültiger Backup-Pfad');

    const root = instanceRoot(this.volumeDir, instance.id);
    await mkdir(root, { recursive: true });

    report?.(20, 'Bisherige Weltdaten werden ersetzt');
    const template = getTemplate(instance.game);
    for (const containerPath of template.backup.paths) {
      const host = toHostPath(this.volumeDir, instance, containerPath);
      if (host && isInside(root, host)) {
        await rm(host, { recursive: true, force: true });
        await mkdir(dirname(host), { recursive: true });
      }
    }

    report?.(50, 'Archiv wird entpackt');
    await pipeline(createReadStream(path), createZstdDecompress(), tarExtract({ cwd: root }));
    report?.(90, 'Wiederherstellung abgeschlossen');
  }

  /**
   * Nimmt ein heruntergeladenes Backup wieder an und führt es als Snapshot.
   * Eingespielt wird es erst über „Restore“ — wie jeder andere Snapshot.
   *
   * Das Archiv kommt aus fremder Hand und wird beim Wiederherstellen ins
   * Instanzverzeichnis entpackt. Deshalb wird es vorher vollständig gelesen:
   * Jeder Eintrag muss unter einem Backup-Pfad der Vorlage liegen, und
   * Verweise sind nicht erlaubt. Sonst könnte ein Archiv Konfiguration oder
   * Mods überschreiben oder per Verweis aus dem Volume hinauszeigen.
   *
   * Ein Backup einer anderen Instanz derselben Vorlage passt ebenfalls: die
   * Einträge sind relativ zum Instanzverzeichnis gespeichert.
   */
  async importUpload(
    instance: InstanceRecord,
    fileName: string,
    stream: NodeJS.ReadableStream,
    isTruncated: () => boolean,
    maxBytes: number,
  ): Promise<Backup> {
    const clean = basename(fileName);
    if (!clean.toLowerCase().endsWith(ARCHIVE_SUFFIX)) {
      throw new BackupError(`Nur Backups des Panels (${ARCHIVE_SUFFIX}) lassen sich hochladen`);
    }

    const dir = this.dirFor(instance.id);
    await mkdir(dir, { recursive: true });
    // Im Backup-Verzeichnis selbst, damit die Übernahme ein `rename` bleibt.
    // Die Liste kommt aus der Datenbank; die halbe Datei sieht niemand.
    const temp = join(dir, `.gsp-upload-${randomUUID()}${ARCHIVE_SUFFIX}`);
    try {
      await pipeline(stream, createWriteStream(temp));
      if (isTruncated()) {
        throw new BackupError(`Die Datei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      await this.checkArchive(instance, temp);

      const file = await this.freeName(dir, clean);
      await rename(temp, join(dir, file));
      const backup: Backup = {
        id: randomUUID(),
        file,
        sizeBytes: (await stat(join(dir, file))).size,
        // Bewusst angelegt — die Aufbewahrungsfrist räumt es nicht weg.
        kind: 'manuell',
        createdAt: new Date().toISOString(),
      };
      this.store.addBackup(instance.id, backup);
      return backup;
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** Liest das Archiv einmal ganz und lehnt ab, was beim Restore Schaden anrichten könnte. */
  private async checkArchive(instance: InstanceRecord, path: string): Promise<void> {
    const template = getTemplate(instance.game);
    const root = instanceRoot(this.volumeDir, instance.id);
    // Dieselbe Form, in der `create()` die Einträge schreibt: relativ zur
    // Instanzwurzel, mit `/` getrennt — auch auf Windows-Hosts.
    const prefixes = template.backup.paths
      .map((p) => toHostPath(this.volumeDir, instance, p))
      .filter((p): p is string => p !== null)
      .map((p) => relative(root, p).split(sep).join('/'))
      .filter((p) => p.length > 0 && !p.startsWith('..'));

    let count = 0;
    // Als Typ ausgeschrieben: TypeScript sieht die Zuweisung im Callback nicht.
    let problem = null as string | null;
    try {
      await pipeline(
        createReadStream(path),
        createZstdDecompress(),
        tarList({
          onReadEntry: (entry) => {
            count += 1;
            if (problem) return;
            const name = entry.path.replace(/^\.\//, '').replace(/\/+$/, '');
            if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
              problem = `„${name}“ ist ein Verweis — Backups mit Verweisen werden nicht angenommen`;
            } else if (name.split('/').includes('..') || name.startsWith('/')) {
              problem = `„${name}“ zeigt aus dem Instanzverzeichnis heraus`;
            } else if (!prefixes.some((p) => name === p || name.startsWith(`${p}/`) || p.startsWith(`${name}/`))) {
              problem = `„${name}“ gehört nicht zu den gesicherten Pfaden dieser Vorlage — stammt das Backup von einem anderen Spiel?`;
            }
          },
        }),
      );
    } catch {
      throw new BackupError('Die Datei ist kein lesbares Backup (tar mit zstd-Kompression erwartet)');
    }
    if (problem) throw new BackupError(problem);
    if (count === 0) throw new BackupError('Das Backup ist leer');
  }

  /** Der hochgeladene Name, solange er frei ist — sonst mit angehängter Nummer. */
  private async freeName(dir: string, wanted: string): Promise<string> {
    const stem = wanted.slice(0, -ARCHIVE_SUFFIX.length).replace(/[^A-Za-z0-9._-]+/g, '-') || 'backup';
    for (let n = 0; ; n += 1) {
      const candidate = `${stem}${n === 0 ? '' : `-${n}`}${ARCHIVE_SUFFIX}`;
      if (!(await stat(join(dir, candidate)).then(() => true, () => false))) return candidate;
    }
  }

  async remove(instance: InstanceRecord, backupId: string): Promise<void> {
    const backup = this.store.getBackup(instance.id, backupId);
    if (!backup) return;
    const path = this.fileFor(instance.id, backup.file);
    if (path) await rm(path, { force: true });
    this.store.removeBackup(instance.id, backupId);
  }

  /** Entfernt automatische Snapshots, die älter als die Aufbewahrungsfrist sind. */
  async applyRetention(instance: InstanceRecord): Promise<void> {
    if (instance.backupKeepDays <= 0) return;
    const cutoff = Date.now() - instance.backupKeepDays * 86_400_000;
    for (const backup of this.store.listBackups(instance.id)) {
      // Manuelle Sicherungen bleiben — sie sind bewusst angelegt worden.
      if (backup.kind === 'manuell') continue;
      if (new Date(backup.createdAt).getTime() >= cutoff) continue;
      await this.remove(instance, backup.id);
    }
  }
}
