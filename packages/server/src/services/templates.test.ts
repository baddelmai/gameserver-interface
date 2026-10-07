import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_DEFINITIONS,
  findTemplate,
  listTemplates,
  minecraftDefinition,
  valheimDefinition,
  type TemplateDefinition,
} from '@gsp/shared';
import { openDb, type Db } from '../db/index.js';
import { Store } from '../db/store.js';
import { TemplateService } from './templates.js';
import { ValidationError } from './instances.js';

describe('Vorlagendienst', () => {
  let tmpRoot: string;
  let db: Db;
  let store: Store;
  let service: TemplateService;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gsp-vorlagen-'));
    db = openDb(join(tmpRoot, 'test.db'));
    store = new Store(db);
    service = new TemplateService(store);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('legt die mitgelieferten Vorlagen beim ersten Start an', () => {
    const { seeded } = service.seedAndLoad();
    expect(seeded).toEqual(BUILTIN_DEFINITIONS.map((d) => d.id));
    // Die Registry bildet den Startbestand vollständig und in derselben
    // Reihenfolge ab — sie bestimmt, wie der Wizard die Karten anordnet.
    expect(listTemplates().map((t) => t.id)).toEqual(BUILTIN_DEFINITIONS.map((d) => d.id));
  });

  /**
   * Der Startbestand durchlaeuft beim Seeding nur das Zod-Schema, nicht die
   * Schluessigkeitspruefung — die haengt an `create`/`update`. Damit koennte
   * eine mitgelieferte Vorlage Widersprueche enthalten, die einer von Hand
   * angelegten verwehrt werden: Backup-Pfade ausserhalb der Volumes,
   * Vorbefehle ohne RCON, Beispielzeilen, die nicht zu den eigenen Mustern
   * passen. Dieser Test schliesst die Luecke.
   */
  it('haelt jede mitgelieferte Vorlage an dieselbe Schluessigkeitspruefung', () => {
    for (const definition of BUILTIN_DEFINITIONS) {
      // `create` prueft; die Kennung ist beim ersten Aufruf noch frei.
      expect(() => service.create({ ...definition, id: `probe-${definition.id}` }), definition.id).not.toThrow();
    }
  });

  /**
   * Der teuerste denkbare Fehler dieses Entwurfs: Ein Panel-Update setzt die
   * Anpassung des Betreibers zurück, lautlos, und es fällt erst beim nächsten
   * Containerbau auf.
   */
  it('überschreibt eine bearbeitete Vorlage beim nächsten Start nicht', () => {
    service.seedAndLoad();

    const changed: TemplateDefinition = {
      ...valheimDefinition,
      label: 'Valheim (angepasst)',
      defaultMemoryMb: 12288,
    };
    service.update('valheim', changed);

    // Zweiter Start des Panels.
    const { seeded } = service.seedAndLoad();

    expect(seeded).toEqual([]);
    expect(findTemplate('valheim')?.label).toBe('Valheim (angepasst)');
    expect(findTemplate('valheim')?.defaultMemoryMb).toBe(12288);
  });

  /**
   * Der Weltblock kam später dazu. Weil Seeding vorhandene Zeilen nie anfasst,
   * hätte ihn ohne Nachrüstung keine bestehende Installation je bekommen — und
   * der Welt-Reiter wäre dort einfach nicht erschienen, ohne Fehlermeldung.
   */
  it('rüstet den Weltblock bei einer Vorlage aus einer älteren Fassung nach', () => {
    const old = { ...minecraftDefinition } as Record<string, unknown>;
    delete old.world;
    const stamp = '2026-01-01T00:00:00.000Z';
    store.upsertTemplate('minecraft', JSON.stringify(old), true, stamp);

    const { backfilled } = service.seedAndLoad();

    expect(backfilled).toContain('minecraft');
    expect(findTemplate('minecraft')?.world?.parent).toBe('/data');
    // Der Container ändert sich dadurch nicht — sonst böte die Oberfläche
    // grundlos „Neu aufbauen“ an.
    expect(store.getTemplateRow('minecraft')?.updated_at).toBe(stamp);
  });

  it('lässt einen selbst gesetzten Weltblock bei der Nachrüstung stehen', () => {
    service.seedAndLoad();
    const own: TemplateDefinition = {
      ...minecraftDefinition,
      world: {
        parent: '/data',
        name: { kind: 'const', value: 'eigenewelt' },
        parts: [{ suffix: '', type: 'dir', required: true }],
        markers: [],
        accept: [],
      },
    };
    service.update('minecraft', own);

    service.seedAndLoad();

    expect(findTemplate('minecraft')?.world?.name).toEqual({ kind: 'const', value: 'eigenewelt' });
  });

  /**
   * Valheim hat seit 1.0 keine `.fwl`/`.db`-Dateien mehr, sondern ein
   * Weltverzeichnis — anders als beim reinen Nachrüsten hatte das Feld `world`
   * hier vorher schon einen Wert, nur in der alten Form. Ohne diese Migration
   * bliebe eine vor dem Umbau angelegte Installation für immer beim alten
   * Dateipaar, und der Welt-Reiter suchte am neuen Container nach Dateien, die
   * es nicht mehr gibt.
   */
  it('hebt eine Valheim-Zeile vom alten Dateipaar auf das neue Weltverzeichnis', () => {
    const old = {
      ...valheimDefinition,
      world: {
        parent: '/config/worlds_local',
        name: { kind: 'field', field: 'worldName' },
        parts: [
          { suffix: '.fwl', type: 'file', required: true },
          { suffix: '.db', type: 'file', required: true },
          { suffix: '.fwl.old', type: 'file', required: false },
          { suffix: '.db.old', type: 'file', required: false },
        ],
        markers: [],
        accept: [],
      },
    };
    const stamp = '2026-01-01T00:00:00.000Z';
    store.upsertTemplate('valheim', JSON.stringify(old), true, stamp);

    const { migrated } = service.seedAndLoad();

    expect(migrated).toContain('valheim');
    expect(findTemplate('valheim')?.world?.parts).toEqual([
      { suffix: '', type: 'dir', required: true },
    ]);
    // Der Container ändert sich dadurch nicht — sonst böte die Oberfläche
    // grundlos „Neu aufbauen“ an.
    expect(store.getTemplateRow('valheim')?.updated_at).toBe(stamp);
  });

  it('lässt eine schon migrierte oder eigene Valheim-Zeile in Ruhe', () => {
    service.seedAndLoad();
    const own: TemplateDefinition = {
      ...valheimDefinition,
      world: {
        parent: '/config/worlds_local',
        name: { kind: 'const', value: 'eigenewelt' },
        parts: [{ suffix: '', type: 'dir', required: true }],
        markers: [],
        accept: [],
      },
    };
    service.update('valheim', own);

    const { migrated } = service.seedAndLoad();

    expect(migrated).not.toContain('valheim');
    expect(findTemplate('valheim')?.world?.name).toEqual({ kind: 'const', value: 'eigenewelt' });
  });

  it('verweigert das Löschen, solange Instanzen darauf beruhen', () => {
    service.seedAndLoad();
    store.insertInstance({
      id: 'i1', game: 'valheim', name: 'Midgard', tag: 'latest',
      containerName: 'gsp-midgard-i1', containerId: null,
      ports: { game: 2456, query: 2457 }, memoryMb: 8192, cpus: 4,
      settings: {}, secrets: {}, backupCron: '', backupKeepDays: 7,
      peakPlayers: 0, lastBootSec: null, templateRev: null,
      createdAt: new Date().toISOString(),
    });

    expect(() => service.remove('valheim')).toThrow(ValidationError);
    expect(findTemplate('valheim')).not.toBeNull();

    // Ohne Instanz geht es.
    store.deleteInstance('i1');
    service.remove('valheim');
    expect(findTemplate('valheim')).toBeNull();
  });

  it('nimmt eine eigene Vorlage an und stellt sie in die Registry', () => {
    service.seedAndLoad();
    service.create(customTemplate());
    expect(findTemplate('testspiel')?.label).toBe('Testspiel');
    expect(findTemplate('testspiel')?.env({ world: 'Alpha' }, { hostPorts: { game: 7777 }, timezone: 'UTC' })).toEqual({
      WORLD: 'Alpha',
      PORT: '7777',
      TZ: 'UTC',
    });
  });

  it('lehnt eine zweite Vorlage mit derselben Kennung ab', () => {
    service.seedAndLoad();
    service.create(customTemplate());
    expect(() => service.create(customTemplate())).toThrow(/bereits/);
  });

  describe('Schlüssigkeitsprüfung', () => {
    beforeEach(() => service.seedAndLoad());

    it('meldet Env-Verweise auf unbekannte Felder und Ports', () => {
      const broken = customTemplate();
      broken.env = [
        { name: 'A', source: { kind: 'field', field: 'gibtsNicht' }, trim: false, omitWhenEmpty: false },
        { name: 'B', source: { kind: 'port', port: 'auchNicht' }, trim: false, omitWhenEmpty: false },
      ];
      const errors = catchValidation(() => service.create(broken));
      expect(errors.fields.map((f) => f.message)).toEqual([
        'Unbekanntes Feld „gibtsNicht“',
        'Unbekannter Port „auchNicht“',
      ]);
    });

    it('lässt Backup-Pfade außerhalb der Volumes nicht zu', () => {
      const broken = customTemplate();
      broken.backup.paths = ['/woanders/welt'];
      expect(catchValidation(() => service.create(broken)).fields[0]?.message).toMatch(/keinem der deklarierten Volumes/);
    });

    it('verlangt einen Abfrageport, wenn die Spielerzahl per Steam-Query kommt', () => {
      const broken = customTemplate();
      broken.capabilities.players = 'a2s';
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'adapter.queryPortName')).toBe(true);
    });

    it('lehnt Vorbefehle ohne Konsole ab', () => {
      const broken = customTemplate();
      broken.backup.preCommands = ['save-all'];
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'backup.preCommands')).toBe(true);
    });

    it('verlangt einen RCON-Port, sobald die Konsole ihn braucht', () => {
      const broken = customTemplate();
      broken.capabilities.console = 'rcon';
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'adapter.rconPortName')).toBe(true);
    });

    it('lehnt Kick und Bann ohne Konsole ab', () => {
      const broken = customTemplate();
      broken.capabilities.moderation = true;
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'capabilities.moderation')).toBe(true);
    });

    it('lehnt ein Listenformat ab, wenn die Spielerliste nicht über RCON kommt', () => {
      const broken = customTemplate();
      broken.adapter.rconListFormat = 'csv';
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'adapter.rconListFormat')).toBe(true);
    });

    /**
     * Log-Muster laufen gegen jede Zeile des Servers, und Node kennt keine
     * Zeitgrenze für reguläre Ausdrücke. Ein Muster mit verschachtelten
     * Wiederholungen kann das Panel deshalb dauerhaft beschäftigen.
     */
    it('lehnt Log-Muster mit verschachtelten Wiederholungen ab', () => {
      const broken = customTemplate();
      broken.logPatterns.join = { source: '(a+)+$', flags: '' };
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'logPatterns.join')).toBe(true);
    });

    it('lehnt syntaktisch kaputte Muster ab', () => {
      const broken = customTemplate();
      broken.logPatterns.ready = { source: '([unvollstaendig', flags: '' };
      expect(catchValidation(() => service.create(broken)).fields.some((f) => f.field === 'logPatterns.ready')).toBe(true);
    });
  });
});

function catchValidation(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err;
    throw err;
  }
  throw new Error('Es wurde kein Fehler geworfen');
}

/** Eine minimale, gültige Vorlage — jeder Test verbiegt davon genau eine Sache. */
function customTemplate(): TemplateDefinition {
  return {
    id: 'testspiel',
    label: 'Testspiel',
    summary: 'Nur für Tests.',
    image: 'beispiel/testspiel',
    defaultTag: 'latest',
    defaultMemoryMb: 2048,
    defaultCpus: 2,
    notes: [],
    capabilities: { console: 'readonly', players: 'log', mods: 'none', moderation: false },
    ports: [
      { name: 'game', label: 'Spielport', container: 7777, protocol: 'udp', defaultHost: 7777, internalOnly: false },
    ],
    volumes: [{ name: 'data', containerPath: '/data', role: 'data' }],
    fields: [
      {
        id: 'world', label: 'Welt', type: 'text', default: 'Alpha',
        required: true, editable: true, restartRequired: true, secret: false,
      },
    ],
    env: [
      { name: 'WORLD', source: { kind: 'field', field: 'world' }, trim: false, omitWhenEmpty: false },
      { name: 'PORT', source: { kind: 'port', port: 'game' }, trim: false, omitWhenEmpty: false },
      { name: 'TZ', source: { kind: 'timezone' }, trim: false, omitWhenEmpty: false },
    ],
    logPatterns: {
      join: { source: 'Spieler (\\S+) betritt', flags: '' },
      ready: { source: 'Server bereit', flags: '' },
    },
    fakeLog: {
      timeFormat: 'iso',
      join: '[{time}] Spieler {name} betritt den Acker',
      leave: '[{time}] Spieler {name} verlaesst den Acker',
      ready: '[{time}] Server bereit',
      chatter: '[{time}] Feld gepfluegt ({n} ms)',
    },
    backup: { paths: ['/data'], preCommands: [], postCommands: [] },
    validations: [],
    adapter: {},
    modExtensions: [],
  };
}
