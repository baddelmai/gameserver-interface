import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadBuiltinTemplates } from '@gsp/shared';
import type { Config } from '../config.js';
import type { InstanceRecord } from '../db/store.js';
import { WorldService } from './world.js';
import { extract, readEntries, packZip, collectEntries } from './world-zip.js';
import { MappingError } from './world-mapping.js';

/**
 * Der Weltdienst mit echten Dateien. Die Zuordnungslogik selbst steht in
 * `welt-zuordnung.test.ts` als Tabelle; hier geht es um das, was sich nur am
 * Dateisystem zeigt — der Rundlauf und die Zusage, dass ein kaputtes Archiv die
 * bisherige Welt stehen lässt.
 */

let tmpRoot: string;
let config: Config;

function instance(game: string, settings: Record<string, string>): InstanceRecord {
  return {
    id: 'i1',
    game,
    name: 'Nordheim',
    tag: 'latest',
    containerName: 'gsp-nordheim-i1',
    containerId: null,
    ports: {},
    memoryMb: 2048,
    cpus: 2,
    settings,
    secrets: {},
    backupCron: '',
    backupKeepDays: 7,
    peakPlayers: 0,
    lastBootSec: null,
    templateRev: null,
    createdAt: new Date().toISOString(),
  } as InstanceRecord;
}

/** Legt eine Datei samt Elternverzeichnissen an. */
function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** Baut ein ZIP aus einer Namen→Inhalt-Tabelle. */
async function buildZip(path: string, dateien: Record<string, string>): Promise<string> {
  const srcDir = mkdtempSync(join(tmpRoot, 'zipquelle-'));
  const entries = Object.entries(dateien).map(([name, content]) => {
    const host = join(srcDir, name.replaceAll('/', '__'));
    writeFileSync(host, content);
    return { hostPath: host, name };
  });
  await pipeline(Readable.from(packZip(entries, false) as unknown as AsyncIterable<Buffer>), createWriteStream(path));
  return path;
}

beforeAll(() => {
  loadBuiltinTemplates();
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gsp-welt-'));
  config = {
    volumeDir: join(tmpRoot, 'instances'),
    tempDir: join(tmpRoot, 'tmp'),
    worldUploadMaxBytes: 64 * 1024 * 1024,
  } as Config;
  mkdirSync(config.volumeDir, { recursive: true });
  mkdirSync(config.tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Host-Pfad innerhalb eines Volumes dieser Testinstanz. Der Volumename ist je
 * Vorlage verschieden — Minecraft nennt es `data`, Terraria `worlds`.
 */
function worldPath(volume: string, ...parts: string[]): string {
  return join(config.volumeDir, 'i1', volume, ...parts);
}

describe('Auskunft', () => {
  it('meldet fehlende Teile, statt sie zu verschweigen', async () => {
    writeFile(worldPath('data', 'welt', 'level.dat'), 'x'.repeat(100));
    const info = await new WorldService(config).info(instance('minecraft', { levelName: 'welt' }));

    expect(info?.name).toBe('welt');
    expect(info?.nameField).toBe('levelName');
    expect(info?.parts.map((t) => [t.name, t.present])).toEqual([
      ['welt', true],
      ['welt_nether', false],
      ['welt_the_end', false],
    ]);
    expect(info?.sizeBytes).toBe(100);
    // Ein Verzeichnis wird nie roh ausgeliefert.
    expect(info?.raw).toBe(false);
    expect(info?.downloadName).toMatch(/^nordheim-welt-.*\.zip$/);
  });

  it('gibt null zurück, wenn die Vorlage keine Weltdaten benennt', async () => {
    expect(await new WorldService(config).info(instance('cs2', {}))).toBeNull();
  });
});

describe('rohe Datei statt Archiv', () => {
  it('liefert Terrarias Weltdatei roh und hängt die fehlende Endung an', async () => {
    writeFile(worldPath('worlds', 'welt'), 'weltdaten');
    const service = new WorldService(config);
    const info = await service.info(instance('terraria', { worldName: 'welt' }));

    expect(info?.raw).toBe(true);
    // Auf der Platte heißt sie `welt` — dem Benutzer nützt erst `welt.wld`.
    expect(info?.downloadName).toBe('welt.wld');
  });

  it('schaltet auf ZIP um, sobald die TShock-Datei danebenliegt', async () => {
    writeFile(worldPath('worlds', 'welt'), 'weltdaten');
    writeFile(worldPath('worlds', 'welt.twld'), 'regionen');
    const info = await new WorldService(config).info(instance('terraria', { worldName: 'welt' }));

    expect(info?.raw).toBe(false);
    expect(info?.downloadName).toMatch(/\.zip$/);
  });

  /*
   * Der Factorio-Sonderfall: Der Spielstand ist selbst ein ZIP. Er darf beim
   * Hochladen nie entpackt werden, sonst käme statt der Welt ihr Inhalt an.
   */
  it('nimmt ein hochgeladenes .zip bei Factorio als die Welt selbst', () => {
    const service = new WorldService(config);
    const target = service.target(instance('factorio', { saveName: 'welt' }))!;
    expect(service.isRawWorldFile(target, '.zip')).toBe(true);

    const mcZiel = service.target(instance('minecraft', { levelName: 'welt' }))!;
    expect(service.isRawWorldFile(mcZiel, '.zip')).toBe(false);
  });
});

describe('Entgegennahme', () => {
  it('lehnt eine Datei mit unpassender Endung ab', async () => {
    const service = new WorldService(config);
    const target = service.target(instance('minecraft', { levelName: 'welt' }))!;
    await expect(service.receive(target, 'welt.exe', Readable.from(['x']))).rejects.toThrow(/zulässig/);
  });

  it('nimmt einen Pfad im Dateinamen nicht als Pfad', async () => {
    const service = new WorldService(config);
    const target = service.target(instance('minecraft', { levelName: 'welt' }))!;
    const { path, fileName } = await service.receive(target, '../../boese.zip', Readable.from(['x']));
    expect(fileName).toBe('boese.zip');
    expect(path.startsWith(config.tempDir)).toBe(true);
  });
});

describe('Bedrock-Karten (.mcworld)', () => {
  const bedrock = () => instance('minecraft-bedrock', { levelName: 'Bedrock level' });

  it('nimmt .mcworld an und bietet sie im Dateidialog an', async () => {
    const service = new WorldService(config);
    const target = service.target(bedrock())!;
    const { ext } = await service.receive(target, 'Skyblock.mcworld', Readable.from(['x']));
    expect(ext).toBe('.mcworld');
    // Entpackt wird sie trotzdem — sie ist keine rohe Weltdatei.
    expect(service.isRawWorldFile(target, '.mcworld')).toBe(false);
    expect((await service.info(bedrock()))?.accept).toEqual(['.zip', '.mcworld']);
  });

  it('spielt eine .mcworld ohne Hülle unter dem Weltnamen der Instanz ein', async () => {
    writeFile(worldPath('data', 'worlds', 'Bedrock level', 'level.dat'), 'alt');
    writeFile(worldPath('data', 'worlds', 'Bedrock level', 'db', '000001.ldb'), 'alt');

    // So liegt eine Karte aus dem Marketplace oder von einer Kartenseite vor:
    // alles auf oberster Ebene, kein umschließender Ordner.
    const archive = await buildZip(join(tmpRoot, 'Skyblock.mcworld'), {
      'level.dat': 'skyblock',
      'levelname.txt': 'Skyblock',
      'db/CURRENT': 'MANIFEST-000002',
      'db/000005.ldb': 'chunks',
    });

    await new WorldService(config).importWorld(
      bedrock(),
      { path: archive, ext: '.mcworld' },
      extract,
      (a) => readEntries(a, config.worldUploadMaxBytes),
      () => {},
    );

    const dir = (...p: string[]) => worldPath('data', 'worlds', 'Bedrock level', ...p);
    expect(readFileSync(dir('level.dat'), 'utf8')).toBe('skyblock');
    expect(readFileSync(dir('levelname.txt'), 'utf8')).toBe('Skyblock');
    expect(readFileSync(dir('db', '000005.ldb'), 'utf8')).toBe('chunks');
    // Die Datenbank der alten Welt darf nicht mit der neuen vermischt werden.
    expect(() => readFileSync(dir('db', '000001.ldb'))).toThrow();
  });
});

describe('Austausch', () => {
  const service = () => new WorldService(config);

  it('ersetzt eine Welt und benennt den Ordner des Archivs um', async () => {
    writeFile(worldPath('data', 'welt', 'level.dat'), 'alt');
    writeFile(worldPath('data', 'welt', 'region', 'r.0.0.mca'), 'altealt');

    const archive = await buildZip(join(tmpRoot, 'neu.zip'), {
      'Hügelland/level.dat': 'neu',
      'Hügelland/region/r.1.1.mca': 'neuneu',
    });

    await service().importWorld(
      instance('minecraft', { levelName: 'welt' }),
      { path: archive, ext: '.zip' },
      extract,
      (a) => readEntries(a, config.worldUploadMaxBytes),
      () => {},
    );

    expect(readFileSync(worldPath('data', 'welt', 'level.dat'), 'utf8')).toBe('neu');
    expect(readFileSync(worldPath('data', 'welt', 'region', 'r.1.1.mca'), 'utf8')).toBe('neuneu');
    // Reste der alten Welt dürfen nicht liegenbleiben.
    expect(() => readFileSync(worldPath('data', 'welt', 'region', 'r.0.0.mca'))).toThrow();
  });

  /*
   * Die Zusage, die diesen Dienst von `BackupService.restore()` unterscheidet:
   * der löscht zuerst und entpackt dann. Bei einer Datei aus fremder Hand wäre
   * das der Verlust der bisherigen Welt.
   */
  it('lässt die bisherige Welt unangetastet, wenn das Archiv unbrauchbar ist', async () => {
    writeFile(worldPath('data', 'welt', 'level.dat'), 'alt');
    const archive = await buildZip(join(tmpRoot, 'fremd.zip'), { 'liesmich.txt': 'nichts' });

    await expect(
      service().importWorld(
        instance('minecraft', { levelName: 'welt' }),
        { path: archive, ext: '.zip' },
        extract,
        (a) => readEntries(a, config.worldUploadMaxBytes),
        () => {},
      ),
    ).rejects.toThrow(MappingError);

    expect(readFileSync(worldPath('data', 'welt', 'level.dat'), 'utf8')).toBe('alt');
  });

  it('spielt eine rohe Weltdatei unter dem Namen der Instanz ein', async () => {
    writeFile(worldPath('worlds', 'welt'), 'alt');
    const raw = join(tmpRoot, 'Meine Welt.wld');
    writeFileSync(raw, 'neu');

    await service().importWorld(
      instance('terraria', { worldName: 'welt' }),
      { path: raw, ext: '.wld' },
      extract,
      (a) => readEntries(a, config.worldUploadMaxBytes),
      () => {},
    );

    expect(readFileSync(worldPath('worlds', 'welt'), 'utf8')).toBe('neu');
  });

  it('räumt Reste eines abgestürzten Laufs weg, statt sie mitzupacken', async () => {
    writeFile(worldPath('data', 'welt', 'level.dat'), 'alt');
    writeFile(worldPath('data', '.gsp-welt-abgestuerzt', 'muell.dat'), 'rest');

    const archive = await buildZip(join(tmpRoot, 'neu.zip'), { 'welt/level.dat': 'neu' });
    await service().importWorld(
      instance('minecraft', { levelName: 'welt' }),
      { path: archive, ext: '.zip' },
      extract,
      (a) => readEntries(a, config.worldUploadMaxBytes),
      () => {},
    );

    expect(() => readFileSync(worldPath('data', '.gsp-welt-abgestuerzt', 'muell.dat'))).toThrow();
  });
});

describe('Rundlauf', () => {
  it('packt eine Welt und spielt sie unverändert wieder ein', async () => {
    writeFile(worldPath('data', 'welt', 'level.dat'), 'inhalt-a');
    writeFile(worldPath('data', 'welt', 'region', 'r.0.0.mca'), 'inhalt-b');
    writeFile(worldPath('data', 'welt_nether', 'level.dat'), 'inhalt-c');

    const entries = [
      ...(await collectEntries(worldPath('data', 'welt'), 'welt')),
      ...(await collectEntries(worldPath('data', 'welt_nether'), 'welt_nether')),
    ];
    const archive = join(tmpRoot, 'rund.zip');
    await pipeline(
      Readable.from(packZip(entries, false) as unknown as AsyncIterable<Buffer>),
      createWriteStream(archive),
    );

    // Die Welt danach zerstören, damit nur das Archiv sie zurückbringen kann.
    rmSync(worldPath('data', 'welt'), { recursive: true });
    rmSync(worldPath('data', 'welt_nether'), { recursive: true });

    await new WorldService(config).importWorld(
      instance('minecraft', { levelName: 'welt' }),
      { path: archive, ext: '.zip' },
      extract,
      (a) => readEntries(a, config.worldUploadMaxBytes),
      () => {},
    );

    expect(readFileSync(worldPath('data', 'welt', 'level.dat'), 'utf8')).toBe('inhalt-a');
    expect(readFileSync(worldPath('data', 'welt', 'region', 'r.0.0.mca'), 'utf8')).toBe('inhalt-b');
    expect(readFileSync(worldPath('data', 'welt_nether', 'level.dat'), 'utf8')).toBe('inhalt-c');
  });
});
