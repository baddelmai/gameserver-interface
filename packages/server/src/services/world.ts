import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  backupStamp,
  getTemplate,
  worldTarget,
  type WorldTarget,
  type WorldTargetPart,
} from '@gsp/shared';
import type { InstanceRecord } from '../db/store.js';
import type { Config } from '../config.js';
import { isInside, slug, toHostPath } from './paths.js';
import { mapArchive, type Mapping } from './world-mapping.js';

/**
 * Die Spielwelt einer Instanz herunterladen und austauschen.
 *
 * Die Volumes sind Bind-Mounts, also arbeitet der Dienst — wie `ModService` —
 * direkt auf Host-Pfaden und streamt nichts durch den Container.
 *
 * Abgegrenzt gegen `BackupService`: der sichert panelintern nach `.tar.zst` und
 * spielt an derselben Stelle zurück. Hier geht es um den Weg nach draußen und
 * wieder herein, also um ein Format, das ein Mensch öffnen kann, und um
 * Archive, die aus fremder Hand kommen und deshalb misstrauisch gelesen werden.
 */

/** Ein Teil der Welt, wie er auf der Platte vorgefunden wurde. */
export interface WorldPartInfo {
  name: string;
  type: 'dir' | 'file';
  sizeBytes: number;
  modifiedAt: string | null;
  /** Fehlt auf der Platte — ein optionaler Teil, den es (noch) nicht gibt. */
  present: boolean;
}

export interface WorldInfo {
  name: string;
  /** Feld, aus dem der Name stammt — für den Hinweis „steht im Config-Reiter“. */
  nameField: string | null;
  parts: WorldPartInfo[];
  sizeBytes: number;
  modifiedAt: string | null;
  /** Der Download liefert eine rohe Datei statt eines ZIP. */
  raw: boolean;
  /** Name, den der Download tragen wird — die Oberfläche nennt ihn vorab. */
  downloadName: string;
  /** Was der Dateidialog annehmen soll. */
  accept: string[];
  maxUploadBytes: number;
}

/** Ein Teil samt aufgelöstem Host-Pfad. */
export interface WorldPartPath extends WorldTargetPart {
  hostPath: string;
}

export class WorldError extends Error {}

export class WorldService {
  constructor(private readonly config: Config) {}

  /** Die Weltangabe der Vorlage, gegen die Einstellungen aufgelöst. */
  target(instance: InstanceRecord): WorldTarget | null {
    return worldTarget(getTemplate(instance.game), instance.settings);
  }

  /**
   * Host-Pfade aller Teile. `toHostPath()` gibt `null` zurück, wenn ein Pfad in
   * keinem Volume liegt — dann stimmt die Vorlage nicht, und es wird nichts
   * angefasst.
   */
  private partPaths(instance: InstanceRecord, target: WorldTarget): WorldPartPath[] {
    const partPaths: WorldPartPath[] = [];
    for (const part of target.parts) {
      const hostPath = toHostPath(this.config.volumeDir, instance, part.containerPath);
      if (!hostPath) {
        throw new WorldError(`„${part.containerPath}“ liegt in keinem Volume der Vorlage`);
      }
      partPaths.push({ ...part, hostPath });
    }
    return partPaths;
  }

  /** Host-Pfad des Elternverzeichnisses, in dem die Welt liegt. */
  private parentPath(instance: InstanceRecord, target: WorldTarget): string {
    const path = toHostPath(this.config.volumeDir, instance, target.parent);
    if (!path) throw new WorldError(`„${target.parent}“ liegt in keinem Volume der Vorlage`);
    return path;
  }

  /** Auskunft für den Welt-Reiter. `null`, wenn die Vorlage keine Welt benennt. */
  async info(instance: InstanceRecord): Promise<WorldInfo | null> {
    const target = this.target(instance);
    if (!target) return null;

    const parts: WorldPartInfo[] = [];
    let total = 0;
    let newest: number | null = null;

    for (const part of this.partPaths(instance, target)) {
      const info = await stat(part.hostPath).catch(() => null);
      if (!info) {
        parts.push({ name: part.fileName, type: part.type, sizeBytes: 0, modifiedAt: null, present: false });
        continue;
      }
      const size = info.isDirectory() ? await directorySize(part.hostPath) : info.size;
      total += size;
      const time = info.mtimeMs;
      if (newest === null || time > newest) newest = time;
      parts.push({
        name: part.fileName,
        type: part.type,
        sizeBytes: size,
        modifiedAt: new Date(time).toISOString(),
        present: true,
      });
    }

    const present = parts.filter((t) => t.present);
    const raw = this.isRaw(target, present.map((t) => t.name));
    const nameSource = getTemplate(instance.game).world?.name;

    return {
      name: target.base,
      nameField: nameSource?.kind === 'field' ? nameSource.field : null,
      parts: parts,
      sizeBytes: total,
      modifiedAt: newest === null ? null : new Date(newest).toISOString(),
      raw: raw,
      downloadName: this.downloadName(instance, target, raw),
      accept: uploadExtensions(target),
      maxUploadBytes: this.config.worldUploadMaxBytes,
    };
  }

  /**
   * Eine rohe Datei statt eines ZIP — wenn die Welt aus einer einzelnen Datei
   * besteht und keine weiteren Teile daneben liegen.
   *
   * Ein Factorio-Spielstand *ist* ein ZIP; ihn in ein zweites zu legen ergäbe
   * eine Matrjoschka. Und der Rundlauf trägt nur so: Was herauskommt, nimmt der
   * Upload roh wieder an.
   */
  isRaw(target: WorldTarget, vorhandeneNamen: string[]): boolean {
    if (target.main.type !== 'file') return false;
    return vorhandeneNamen.length === 1 && vorhandeneNamen[0] === target.main.fileName;
  }

  /** Dateiname des Downloads. */
  downloadName(instance: InstanceRecord, target: WorldTarget, raw: boolean): string {
    if (!raw) return `${slug(instance.name)}-${slug(target.base)}-${backupStamp()}.zip`;
    // Terrarias Datei heißt auf der Platte `welt` — ohne Endung nützt sie
    // niemandem, deshalb hängt `accept[0]` sie an.
    const ext = extname(target.main.fileName);
    return ext === '' && target.accept[0] ? `${target.main.fileName}${target.accept[0]}` : target.main.fileName;
  }

  /** Die Teile, die tatsächlich auf der Platte liegen. */
  async existingParts(instance: InstanceRecord, target: WorldTarget): Promise<WorldPartPath[]> {
    const found: WorldPartPath[] = [];
    for (const part of this.partPaths(instance, target)) {
      if (await stat(part.hostPath).then(() => true).catch(() => false)) found.push(part);
    }
    return found;
  }

  /**
   * Nimmt eine hochgeladene Datei entgegen und legt sie im Temp-Verzeichnis ab.
   *
   * Bewusst nicht `request.saveRequestFiles()`: das räumt über einen
   * `onResponse`-Hook auf, sobald die Antwort raus ist — der Job läuft danach
   * noch minutenlang und fände nichts mehr vor.
   */
  async receive(
    target: WorldTarget,
    fileName: string,
    stream: NodeJS.ReadableStream,
  ): Promise<{ path: string; fileName: string; ext: string }> {
    const clean = basename(fileName);
    const ext = extname(clean).toLowerCase();
    const allowed = uploadExtensions(target);
    if (!allowed.includes(ext)) {
      throw new WorldError(`Für dieses Spiel sind nur ${allowed.join(', ')} zulässig`);
    }

    await mkdir(this.config.tempDir, { recursive: true });
    const path = join(this.config.tempDir, `welt-${randomUUID()}${ext}`);
    try {
      await pipeline(stream, createWriteStream(path));
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return { path, fileName: clean, ext };
  }

  /**
   * Wird die hochgeladene Datei entpackt oder unverändert als Welt genommen?
   *
   * Die eine Regel, die den Factorio-Sonderfall auflöst: Führt die Vorlage die
   * Endung in `accept`, ist die Datei die Welt selbst. Sonst ist sie ein Archiv.
   */
  isRawWorldFile(target: WorldTarget, ext: string): boolean {
    return target.accept.includes(ext);
  }

  /**
   * Ersetzt die Weltdaten. Der Aufrufer muss sichergestellt haben, dass die
   * Instanz gestoppt ist.
   *
   * **Erst entpacken, dann löschen.** `BackupService.restore()` macht es
   * andersherum und lässt bei einem kaputten Archiv eine leere Instanz zurück;
   * dort ist das verschmerzbar, weil das Archiv aus dem Panel selbst stammt.
   * Bei einer Datei aus fremder Hand ist es das nicht.
   */
  async importWorld(
    instance: InstanceRecord,
    nameSource: { path: string; ext: string },
    extract: (archiv: string, mappings: Mapping[], into: string) => Promise<void>,
    readEntries: (archiv: string) => Promise<string[]>,
    report: (progress: number, message: string) => void,
  ): Promise<{ parts: string[] }> {
    const target = this.target(instance);
    if (!target) throw new WorldError('Diese Vorlage benennt keine Weltdaten');

    const parent = this.parentPath(instance, target);
    const instanceRootDir = join(this.config.volumeDir, instance.id);
    // Das Zwischenverzeichnis liegt als Geschwister im selben Volume, damit das
    // spätere Verschieben ein `rename` bleibt und nicht auf `EXDEV` läuft.
    const staging = join(parent, `.gsp-welt-${randomUUID()}`);

    await cleanStaleStaging(parent);
    await mkdir(staging, { recursive: true });

    try {
      report(40, 'Neue Weltdaten werden gelesen');
      let newParts: string[];

      if (this.isRawWorldFile(target, nameSource.ext)) {
        // Rohe Einzeldatei: sie *ist* die Welt und wird nur umbenannt.
        if (target.main.type !== 'file') {
          throw new WorldError('Für dieses Spiel wird ein ZIP erwartet, keine einzelne Datei');
        }
        const into = join(staging, target.main.fileName);
        await pipeline(createReadStream(nameSource.path), createWriteStream(into));
        newParts = [target.main.fileName];
      } else {
        const entries = await readEntries(nameSource.path);
        const mappings = mapArchive(entries, target);
        report(55, 'Neue Weltdaten werden entpackt');
        await extract(nameSource.path, mappings, staging);
        newParts = [...new Set(mappings.map((z) => z.target.split('/')[0]!))];
      }

      // Erst jetzt ist das Neue vollständig da — die alte Welt kann weichen.
      report(85, 'Bisherige Weltdaten werden ersetzt');
      for (const part of this.partPaths(instance, target)) {
        if (!isInside(instanceRootDir, part.hostPath)) {
          throw new WorldError(`„${part.hostPath}“ liegt außerhalb der Instanz`);
        }
        await rm(part.hostPath, { recursive: true, force: true });
      }

      for (const name of newParts) {
        const from = join(staging, name);
        const into = join(parent, name);
        if (!isInside(instanceRootDir, into)) throw new WorldError(`„${into}“ liegt außerhalb der Instanz`);
        await mkdir(dirname(into), { recursive: true });
        await rename(from, into);
      }

      return { parts: newParts };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Was der Upload annimmt: rohe Weltdateien (`accept`), ZIP und die Endungen,
 * die nur anders benannte ZIPs sind (`archives`, etwa `.mcworld`).
 */
function uploadExtensions(target: WorldTarget): string[] {
  return [...new Set([...target.accept, '.zip', ...target.archives])];
}

/**
 * Reste abgestürzter Läufe. Sie liegen im Weltverzeichnis und würden sonst beim
 * nächsten Download mitgepackt.
 */
async function cleanStaleStaging(parent: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('.gsp-welt-')) {
      await rm(join(parent, entry.name), { recursive: true, force: true });
    }
  }
}

/** Summe der Dateigrößen unterhalb eines Verzeichnisses. */
async function directorySize(path: string): Promise<number> {
  let sum = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const kind = join(path, entry.name);
    if (entry.isDirectory()) sum += await directorySize(kind);
    else sum += await stat(kind).then((s) => s.size).catch(() => 0);
  }
  return sum;
}
