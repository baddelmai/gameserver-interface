import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FILE_EDIT_MAX_BYTES, loadBuiltinTemplates } from '@gsp/shared';
import type { InstanceRecord } from '../db/store.js';
import { FileError, FileService, normalizeRelative } from './files.js';

/**
 * Der Dateidienst mit echten Dateien. Was hier zählt, zeigt sich nur auf der
 * Platte: Zeilenenden, BOM, Verweise aus dem Volume heraus.
 */

let tmpRoot: string;
let volumeDir: string;
let service: FileService;

const valheim = {
  id: 'i1',
  game: 'valheim',
  name: 'Midgard',
  tag: 'latest',
  containerName: 'gsp-midgard-i1',
  containerId: null,
  ports: {},
  memoryMb: 2048,
  cpus: 2,
  settings: {},
  secrets: {},
  backupCron: '',
  backupKeepDays: 7,
  peakPlayers: 0,
  lastBootSec: null,
  templateRev: null,
  createdAt: new Date().toISOString(),
} as InstanceRecord;

/** Host-Pfad im Volume `config` der Valheim-Instanz. */
const inConfig = (...parts: string[]) => join(volumeDir, 'i1', 'config', ...parts);

function put(path: string, content: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** Erwartet einen `FileError` mit genau diesem Status. */
async function rejectsWith(promise: Promise<unknown>, status: number): Promise<FileError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FileError);
  expect((err as FileError).status).toBe(status);
  return err as FileError;
}

beforeAll(() => loadBuiltinTemplates());

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gsp-files-'));
  volumeDir = join(tmpRoot, 'instances');
  service = new FileService(volumeDir);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('Verzeichnisliste', () => {
  it('zeigt Verzeichnisse vor Dateien und blendet Arbeitsdateien des Panels aus', async () => {
    put(inConfig('adminlist.txt'), 'x');
    put(inConfig('worlds_local', 'Midgard.fwl'), 'x');
    put(inConfig('.gsp-edit-123'), 'halb geschrieben');

    const listing = await service.list(valheim, 'config', '');
    expect(listing.entries.map((e) => [e.name, e.type, e.path])).toEqual([
      ['worlds_local', 'dir', 'worlds_local'],
      ['adminlist.txt', 'file', 'adminlist.txt'],
    ]);

    const sub = await service.list(valheim, 'config', 'worlds_local');
    expect(sub.entries[0]?.path).toBe('worlds_local/Midgard.fwl');
  });

  it('liefert ein leeres Volume, solange die Instanz nie gestartet war', async () => {
    const listing = await service.list(valheim, 'config', '');
    expect(listing.entries).toEqual([]);
  });

  it('kennt nur die Volumes der Vorlage', async () => {
    await rejectsWith(service.list(valheim, 'etc', ''), 404);
  });

  it('lehnt Pfade mit .. ab, statt sie aufzulösen', async () => {
    put(inConfig('a.txt'), 'x');
    await rejectsWith(service.list(valheim, 'config', '../data'), 400);
    await rejectsWith(service.read(valheim, 'config', 'sub/../../../x'), 400);
    expect(() => normalizeRelative('C:/Windows')).toThrow(FileError);
  });

  it('folgt keinem Verweis aus dem Volume heraus', async () => {
    const outside = join(tmpRoot, 'host-geheim');
    put(join(outside, 'shadow'), 'root:x');
    put(inConfig('ok.txt'), 'x');
    // Eine Junction braucht unter Windows keine Adminrechte; auf Linux ist
    // der Typ bedeutungslos und es entsteht ein gewöhnlicher Verweis.
    symlinkSync(outside, inConfig('ausbruch'), 'junction');

    const listing = await service.list(valheim, 'config', '');
    expect(listing.entries.map((e) => e.name)).toEqual(['ok.txt']);
    await rejectsWith(service.list(valheim, 'config', 'ausbruch'), 400);
    await rejectsWith(service.read(valheim, 'config', 'ausbruch/shadow'), 400);
  });
});

describe('Lesen', () => {
  it('liefert den Inhalt mit \\n und merkt sich das ursprüngliche Zeilenende', async () => {
    put(inConfig('server.ini'), 'a=1\r\nb=2\r\n');
    const file = await service.read(valheim, 'config', 'server.ini');
    expect(file.content).toBe('a=1\nb=2\n');
    expect(file.lineEnding).toBe('crlf');
    expect(file.rev).toMatch(/^[0-9a-f]{64}$/);
  });

  it('weist Binärdateien und fremde Kodierungen ab', async () => {
    put(inConfig('welt.db'), Buffer.from([1, 2, 0, 3]));
    put(inConfig('latin1.ini'), Buffer.from('Größe=1', 'latin1'));
    await rejectsWith(service.read(valheim, 'config', 'welt.db'), 415);
    await rejectsWith(service.read(valheim, 'config', 'latin1.ini'), 415);
  });

  it('weist zu große Dateien ab', async () => {
    put(inConfig('gross.txt'), Buffer.alloc(FILE_EDIT_MAX_BYTES + 1, 'a'));
    await rejectsWith(service.read(valheim, 'config', 'gross.txt'), 413);
  });

  it('öffnet kein Verzeichnis als Datei', async () => {
    put(inConfig('worlds_local', 'x'), 'x');
    await rejectsWith(service.read(valheim, 'config', 'worlds_local'), 400);
  });
});

describe('Speichern', () => {
  it('erhält Zeilenende und BOM der Datei', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    put(inConfig('server.ini'), Buffer.concat([bom, Buffer.from('a=1\r\nb=2\r\n')]));
    const before = await service.read(valheim, 'config', 'server.ini');
    expect(before.content).toBe('a=1\nb=2\n');

    await service.write(valheim, {
      volume: 'config', path: 'server.ini', content: 'a=1\nb=3\nc=Größe\n', rev: before.rev, force: false, restart: false,
    });

    const raw = readFileSync(inConfig('server.ini'));
    expect(raw.subarray(0, 3).equals(bom)).toBe(true);
    expect(raw.subarray(3).toString('utf8')).toBe('a=1\r\nb=3\r\nc=Größe\r\n');
  });

  it('überschreibt nichts, was sich seit dem Lesen geändert hat', async () => {
    put(inConfig('adminlist.txt'), 'alt');
    const before = await service.read(valheim, 'config', 'adminlist.txt');
    // Der Server schreibt die Datei beim Beenden zurück …
    writeFileSync(inConfig('adminlist.txt'), 'vom Server');

    await rejectsWith(
      service.write(valheim, {
        volume: 'config', path: 'adminlist.txt', content: 'neu', rev: before.rev, force: false, restart: false,
      }),
      409,
    );
    expect(readFileSync(inConfig('adminlist.txt'), 'utf8')).toBe('vom Server');
  });

  it('lehnt kaputtes JSON ab, außer es wird ausdrücklich verlangt', async () => {
    put(inConfig('settings.json'), '{"a": 1}');
    const before = await service.read(valheim, 'config', 'settings.json');
    const request = { volume: 'config', path: 'settings.json', content: '{"a": 1,}', rev: before.rev, restart: false };

    const err = await rejectsWith(service.write(valheim, { ...request, force: false }), 400);
    expect(err.message).toContain('JSON');
    expect(readFileSync(inConfig('settings.json'), 'utf8')).toBe('{"a": 1}');

    const saved = await service.write(valheim, { ...request, force: true });
    expect(saved.content).toBe('{"a": 1,}');
  });

  it('liefert den neuen Stand zurück, mit dem gleich weitergespeichert werden kann', async () => {
    put(inConfig('a.txt'), 'eins');
    const first = await service.read(valheim, 'config', 'a.txt');
    const second = await service.write(valheim, {
      volume: 'config', path: 'a.txt', content: 'zwei', rev: first.rev, force: false, restart: false,
    });
    expect(second.rev).not.toBe(first.rev);
    const third = await service.write(valheim, {
      volume: 'config', path: 'a.txt', content: 'drei', rev: second.rev, force: false, restart: false,
    });
    expect(third.content).toBe('drei');
  });
});
