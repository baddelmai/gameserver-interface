import { createHash, randomUUID } from 'node:crypto';
import { chmod, chown, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_MAX_ENTRIES,
  formatBytes,
  getTemplate,
  type FileContent,
  type FileEntry,
  type FileListing,
  type SaveFileRequest,
} from '@gsp/shared';
import type { InstanceRecord } from '../db/store.js';
import { isInside, volumePath } from './paths.js';

/**
 * Konfigurationsdateien direkt bearbeiten — die Alternative zum Formular.
 *
 * Wie `ModService` und `WorldService` arbeitet der Dienst auf den Host-Pfaden
 * der Bind-Mounts. Er kann nur lesen und vorhandene Dateien überschreiben;
 * Anlegen, Umbenennen und Löschen gibt es bewusst nicht. Wer eine Datei
 * braucht, die es noch nicht gibt, startet den Server einmal — der legt sie an.
 *
 * **Symbolische Verweise sind der heikle Teil.** Die Volumes gehören dem
 * Container, und ein Prozess darin kann `server.properties -> /etc/shadow`
 * anlegen. Für den Container zeigt das ins Leere; das Panel aber liefe auf dem
 * Host und folgte dem Verweis. Deshalb wird jeder Pfad über `realpath()`
 * aufgelöst und muss danach noch im Volume liegen — `isInside()` allein prüft
 * nur die Zeichenkette.
 */

export class FileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 415,
  ) {
    super(message);
  }
}

/** Arbeitsdateien des Panels — sie gehören nicht in die Liste. */
const INTERNAL_PREFIX = '.gsp-';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Ein aufgelöster Pfad: der echte Ort auf der Platte und wie er in der API heißt. */
interface Located {
  real: string;
  rel: string;
  realRoot: string;
}

export class FileService {
  constructor(private readonly volumeDir: string) {}

  async list(instance: InstanceRecord, volume: string, path: string): Promise<FileListing> {
    const root = this.volumeRoot(instance, volume);
    const rel = normalizeRelative(path);

    // Ein Volume, das es noch nicht gibt, ist kein Fehler: die Instanz wurde
    // nur noch nie gestartet und hat nichts geschrieben.
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) {
      if (rel !== '') throw new FileError('Verzeichnis nicht gefunden', 404);
      return { volume, path: '', entries: [], truncated: false };
    }

    const dir = await this.locate(realRoot, rel);
    const info = await stat(dir.real);
    if (!info.isDirectory()) throw new FileError('Kein Verzeichnis', 400);

    const dirents = await readdir(dir.real, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith(INTERNAL_PREFIX)) continue;
      const host = join(dir.real, dirent.name);

      // Verweise nur zeigen, wenn sie im Volume bleiben — sonst verriete schon
      // die Liste Größe und Zeitstempel einer fremden Datei.
      if (dirent.isSymbolicLink()) {
        const target = await realpath(host).catch(() => null);
        if (!target || !isInside(realRoot, target)) continue;
      }
      const entry = await stat(host).catch(() => null);
      if (!entry || (!entry.isDirectory() && !entry.isFile())) continue;

      entries.push({
        name: dirent.name,
        path: rel === '' ? dirent.name : `${rel}/${dirent.name}`,
        type: entry.isDirectory() ? 'dir' : 'file',
        sizeBytes: entry.isDirectory() ? 0 : entry.size,
        modifiedAt: new Date(entry.mtimeMs).toISOString(),
      });
    }

    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'de') : a.type === 'dir' ? -1 : 1,
    );
    return {
      volume,
      path: rel,
      entries: entries.slice(0, FILE_LIST_MAX_ENTRIES),
      truncated: entries.length > FILE_LIST_MAX_ENTRIES,
    };
  }

  async read(instance: InstanceRecord, volume: string, path: string): Promise<FileContent> {
    const file = await this.locateFile(instance, volume, path);
    const data = await readFile(file.real);
    const decoded = decodeText(data);
    const info = await stat(file.real);
    return {
      volume,
      path: file.rel,
      content: decoded.content,
      rev: revisionOf(data),
      sizeBytes: data.length,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      lineEnding: decoded.lineEnding,
    };
  }

  /**
   * Überschreibt eine vorhandene Datei.
   *
   * Zeilenende und BOM richten sich nach der Datei, nicht nach dem Browser:
   * eine Textarea liefert immer `\n`, und ein unter Wine laufender Server, der
   * seine `.ini` mit `\r\n` schrieb, soll sie nicht plötzlich anders vorfinden.
   */
  async write(instance: InstanceRecord, request: SaveFileRequest): Promise<FileContent> {
    const file = await this.locateFile(instance, request.volume, request.path);

    const current = await readFile(file.real);
    if (revisionOf(current) !== request.rev) {
      throw new FileError(
        'Die Datei wurde inzwischen verändert — vermutlich vom Server selbst. Neu laden und die Änderung erneut eintragen.',
        409,
      );
    }
    const before = decodeText(current);

    let text = request.content.replace(/\r\n/g, '\n');
    if (!request.force) checkSyntax(file.rel, text);
    if (before.lineEnding === 'crlf') text = text.replace(/\n/g, '\r\n');
    const body = Buffer.from(text, 'utf8');
    const data = before.bom ? Buffer.concat([UTF8_BOM, body]) : body;
    if (data.length > FILE_EDIT_MAX_BYTES) {
      throw new FileError(`Die Datei wäre größer als ${formatBytes(FILE_EDIT_MAX_BYTES)}`, 413);
    }

    await replaceKeepingOwner(file.real, data);
    return this.read(instance, request.volume, file.rel);
  }

  /** Host-Pfad eines Volumes der Vorlage; unbekannte Namen sind 404. */
  private volumeRoot(instance: InstanceRecord, volume: string): string {
    const template = getTemplate(instance.game);
    if (!template.volumes.some((v) => v.name === volume)) {
      throw new FileError(`Die Vorlage kennt kein Volume „${volume}“`, 404);
    }
    return volumePath(this.volumeDir, instance.id, volume);
  }

  /** Löst einen relativen Pfad auf und prüft, dass er nach dem Auflösen aller Verweise im Volume bleibt. */
  private async locate(realRoot: string, rel: string): Promise<Located> {
    const candidate = rel === '' ? realRoot : join(realRoot, ...rel.split('/'));
    const real = await realpath(candidate).catch(() => null);
    if (!real) throw new FileError('Nicht gefunden', 404);
    if (!isInside(realRoot, real)) {
      throw new FileError('Der Pfad verweist aus dem Volume heraus', 400);
    }
    return { real, rel, realRoot };
  }

  private async locateFile(instance: InstanceRecord, volume: string, path: string): Promise<Located> {
    const rel = normalizeRelative(path);
    if (rel === '') throw new FileError('Kein Dateipfad angegeben', 400);
    const realRoot = await realpath(this.volumeRoot(instance, volume)).catch(() => null);
    if (!realRoot) throw new FileError('Nicht gefunden', 404);

    const file = await this.locate(realRoot, rel);
    const info = await stat(file.real);
    if (!info.isFile()) throw new FileError('Keine Datei', 400);
    if (info.size > FILE_EDIT_MAX_BYTES) {
      throw new FileError(
        `Die Datei ist ${formatBytes(info.size)} groß — bearbeitet werden nur Dateien bis ${formatBytes(FILE_EDIT_MAX_BYTES)}`,
        413,
      );
    }
    return file;
  }
}

/**
 * Bringt einen Pfad aus der Anfrage in die Form `a/b/c`.
 *
 * `..` wird abgelehnt statt aufgelöst: ein Bedienelement erzeugt es nie, und
 * wer es schickt, will etwas anderes als eine Datei bearbeiten.
 */
export function normalizeRelative(path: string): string {
  if (path.includes('\0')) throw new FileError('Ungültiger Pfad', 400);
  const segments = path.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) throw new FileError('Ungültiger Pfad', 400);
  // Laufwerksbuchstaben würden auf Windows-Hosts `join()` aus dem Volume führen.
  if (segments.some((s) => s.includes(':'))) throw new FileError('Ungültiger Pfad', 400);
  return segments.join('/');
}

export function revisionOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Liest UTF-8 und erkennt Binärdaten.
 *
 * Mit `fatal: true` statt der üblichen Ersetzungszeichen: eine Latin-1-`.ini`
 * käme sonst mit `�` statt Umlauten in den Editor, und nach dem Speichern wären
 * die Umlaute auf der Platte für immer weg.
 */
export function decodeText(data: Buffer): {
  content: string;
  lineEnding: 'lf' | 'crlf';
  bom: boolean;
} {
  if (data.includes(0)) throw new FileError('Das ist keine Textdatei', 415);
  const bom = data.subarray(0, 3).equals(UTF8_BOM);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? data.subarray(3) : data);
  } catch {
    throw new FileError('Die Datei ist nicht UTF-8-kodiert und lässt sich hier nicht verlustfrei bearbeiten', 415);
  }

  // Gemischte Enden werden vereinheitlicht — die Mehrheit entscheidet.
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = text.match(/\n/g)?.length ?? 0;
  return {
    content: text.replace(/\r\n/g, '\n'),
    lineEnding: crlf > 0 && crlf * 2 >= lf ? 'crlf' : 'lf',
    bom,
  };
}

/**
 * Prüft die Syntax, wo sie sich prüfen lässt. Bisher nur JSON — ein Fehler dort
 * lässt Enshrouded oder V Rising beim nächsten Start auf Vorgabewerte
 * zurückfallen oder gar nicht starten, und das fällt erst im Log auf.
 */
export function checkSyntax(path: string, content: string): void {
  if (extname(path).toLowerCase() !== '.json') return;
  try {
    JSON.parse(content);
  } catch (err) {
    throw new FileError(`Kein gültiges JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
}

/**
 * Schreibt atomar: erst eine Arbeitsdatei daneben, dann `rename`. Ein
 * abgebrochener Schreibvorgang hinterlässt so nie eine halbe Konfiguration.
 *
 * Rechte und Eigentümer werden übernommen. Das Panel läuft oft als root, der
 * Spielserver im Container als uid 1000 — eine Datei, die danach root gehört,
 * könnte der Server nicht mehr zurückschreiben, und Satisfactory oder Valheim
 * tun genau das beim Beenden.
 */
async function replaceKeepingOwner(path: string, data: Buffer): Promise<void> {
  const info = await stat(path);
  const temp = join(dirname(path), `${INTERNAL_PREFIX}edit-${randomUUID()}`);
  try {
    await writeFile(temp, data);
    await chmod(temp, info.mode & 0o7777);
    // Nur root darf den Eigentümer setzen. Läuft das Panel ohne, scheitert das
    // still, und die Datei gehört danach dem Panel-Benutzer — besser als gar
    // nicht speichern, aber ein Grund mehr, das Panel als root zu betreiben.
    await chown(temp, info.uid, info.gid).catch(() => undefined);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
