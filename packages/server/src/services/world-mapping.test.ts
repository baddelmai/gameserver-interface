import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileTemplate,
  getTemplate,
  loadBuiltinTemplates,
  minecraftDefinition,
  worldTarget,
  type TemplateDefinition,
  type WorldTarget,
} from '@gsp/shared';
import { MappingError, isDangerous, mapArchive } from './world-mapping.js';

/**
 * Die Zuordnung fremder Archive auf die Weltpfade einer Instanz.
 *
 * Der Teil, an dem ein Fehler Weltdaten kostet: Er löscht die bisherige Welt
 * und legt an ihre Stelle etwas, das der Server nicht lesen kann. Deshalb steht
 * er hier als Tabelle aus Eintragsnamen — ohne Dateisystem, ohne ZIP, ohne
 * Docker.
 */

function target(templateId: string, values: Record<string, string>): WorldTarget {
  const t = worldTarget(getTemplate(templateId), values);
  if (!t) throw new Error(`${templateId} hat keine Weltangabe`);
  return t;
}

/**
 * Ein Weltblock ohne Bezug zu einer echten Vorlage — für Verhalten, das keine
 * mitgelieferte Vorlage mehr in dieser Form zeigt (Suffix-Vorrang bei
 * überlappenden `.old`-Endungen), seit Valheim 1.0 auf ein Weltverzeichnis
 * umgestellt hat.
 */
function syntheticTarget(world: TemplateDefinition['world'], values: Record<string, string>): WorldTarget {
  const definition = { ...minecraftDefinition, world } as TemplateDefinition;
  const t = worldTarget(compileTemplate(definition), values);
  if (!t) throw new Error('Testvorlage hat keine Weltangabe');
  return t;
}

beforeAll(() => {
  loadBuiltinTemplates();
});

describe('gefährliche Einträge', () => {
  it.each([
    '../../etc/passwd',
    'a/../../b',
    '/etc/passwd',
    '\\windows\\system32',
    'C:/Users/henri',
    'welt\\region\\r.mca',
    '',
  ])('lehnt „%s“ ab', (name) => {
    expect(isDangerous(name)).toBe(true);
  });

  it.each(['welt/level.dat', 'Meine Welt.wld', 'welt/region/r.0.0.mca', 'a..b/c'])(
    'lässt „%s“ durch',
    (name) => {
      expect(isDangerous(name)).toBe(false);
    },
  );

  it('bricht die ganze Zuordnung ab, sobald ein Eintrag ausbricht', () => {
    expect(() => mapArchive(['welt/level.dat', '../../etc/passwd'], target('minecraft', { levelName: 'welt' })))
      .toThrow(MappingError);
  });
});

describe('Minecraft — Verzeichnis mit Geschwistern', () => {
  const minecraft = () => target('minecraft', { levelName: 'welt' });

  it('nimmt den Inhalt, wenn die Welt ohne Hülle gepackt wurde', () => {
    expect(mapArchive(['level.dat', 'region/r.0.0.mca'], minecraft())).toEqual([
      { source: 'level.dat', target: 'welt/level.dat' },
      { source: 'region/r.0.0.mca', target: 'welt/region/r.0.0.mca' },
    ]);
  });

  it('schneidet eine anders benannte Hülle ab und benennt um', () => {
    expect(mapArchive(['MeineWelt/level.dat', 'MeineWelt/region/r.0.0.mca'], minecraft())).toEqual([
      { source: 'MeineWelt/level.dat', target: 'welt/level.dat' },
      { source: 'MeineWelt/region/r.0.0.mca', target: 'welt/region/r.0.0.mca' },
    ]);
  });

  /*
   * Der Fall, für den es die Stammzuordnung gibt: Nether und End liegen als
   * Geschwister daneben. Ohne sie käme nur die Oberwelt an, und der Spieler
   * stünde nach dem Portal in einer frisch erzeugten Hölle.
   */
  it('erkennt Nether und End als Geschwister und benennt alle drei um', () => {
    expect(
      mapArchive(
        ['Hügelland/level.dat', 'Hügelland_nether/level.dat', 'Hügelland_the_end/level.dat'],
        minecraft(),
      ),
    ).toEqual([
      { source: 'Hügelland/level.dat', target: 'welt/level.dat' },
      { source: 'Hügelland_nether/level.dat', target: 'welt_nether/level.dat' },
      { source: 'Hügelland_the_end/level.dat', target: 'welt_the_end/level.dat' },
    ]);
  });

  it('findet die Welt über den Marker, wenn sie tiefer liegt', () => {
    expect(mapArchive(['Backup/2026-09/MeineWelt/level.dat', 'Backup/2026-09/MeineWelt/session.lock'], minecraft()))
      .toEqual([
        { source: 'Backup/2026-09/MeineWelt/level.dat', target: 'welt/level.dat' },
        { source: 'Backup/2026-09/MeineWelt/session.lock', target: 'welt/session.lock' },
      ]);
  });

  it('verweigert die Wahl, wenn zwei Welten im Archiv liegen', () => {
    expect(() => mapArchive(['A/level.dat', 'B/level.dat'], minecraft())).toThrow(/mehrere Welten/);
  });

  it('meldet ein Archiv ohne Welt, statt irgendetwas einzuspielen', () => {
    expect(() => mapArchive(['liesmich.txt', 'bilder/screenshot.png'], minecraft())).toThrow(/keine Welt/);
  });

  it('wirft den Beiwerk des Betriebssystems weg', () => {
    expect(
      mapArchive(['__MACOSX/._welt', 'MeineWelt/.DS_Store', 'MeineWelt/level.dat'], minecraft()),
    ).toEqual([{ source: 'MeineWelt/level.dat', target: 'welt/level.dat' }]);
  });
});

describe('Dateigruppe mit gemeinsamem Stamm (Suffix-Vorrang)', () => {
  /*
   * Diese Form — mehrere Dateiendungen mit gemeinsamem Stamm plus `.old`-Kopien
   * — hatte bis Valheim 1.0 die Valheim-Vorlage; seit dem Umstieg auf ein
   * Weltverzeichnis (siehe unten) bringt keine mitgelieferte Vorlage sie mehr
   * mit. Der Fall bleibt trotzdem möglich — deshalb hier synthetisch geprüft.
   */
  const dateipaar = () =>
    syntheticTarget(
      {
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
      { worldName: 'Midgard' },
    );

  it('benennt den Stamm auf den der Instanz um', () => {
    expect(mapArchive(['Welt.fwl', 'Welt.db'], dateipaar())).toEqual([
      { source: 'Welt.fwl', target: 'Midgard.fwl' },
      { source: 'Welt.db', target: 'Midgard.db' },
    ]);
  });

  /*
   * Längstes Suffix zuerst: sonst liest `.db` das `Welt.db.old` als Stamm
   * `Welt.db` und legt es als `Midgard.db.db` ab.
   */
  it('ordnet .old-Kopien dem längeren Suffix zu, nicht dem kürzeren', () => {
    expect(mapArchive(['Welt.fwl', 'Welt.db', 'Welt.db.old'], dateipaar())).toEqual([
      { source: 'Welt.fwl', target: 'Midgard.fwl' },
      { source: 'Welt.db', target: 'Midgard.db' },
      { source: 'Welt.db.old', target: 'Midgard.db.old' },
    ]);
  });

  it('lehnt eine .fwl ohne Karte ab', () => {
    expect(() => mapArchive(['Welt.fwl'], dateipaar())).toThrow(/fehlt/);
  });

  it('verweigert die Wahl bei zwei Welten', () => {
    expect(() => mapArchive(['A.fwl', 'A.db', 'B.fwl', 'B.db'], dateipaar())).toThrow(/mehrere Welten/);
  });
});

describe('Valheim — Weltverzeichnis seit Version 1.0', () => {
  const valheim = () => target('valheim', { worldName: 'Midgard' });

  it('nimmt das Weltverzeichnis, wenn es ohne Hülle gepackt wurde', () => {
    expect(mapArchive(['_main.1.fwl2', '_main.1.db2', '_main.1.chunks', '_main.1.ok'], valheim())).toEqual([
      { source: '_main.1.fwl2', target: 'Midgard/_main.1.fwl2' },
      { source: '_main.1.db2', target: 'Midgard/_main.1.db2' },
      { source: '_main.1.chunks', target: 'Midgard/_main.1.chunks' },
      { source: '_main.1.ok', target: 'Midgard/_main.1.ok' },
    ]);
  });

  it('schneidet eine anders benannte Hülle ab und benennt um', () => {
    expect(mapArchive(['Welt/_main.1.fwl2', 'Welt/_main.1.db2'], valheim())).toEqual([
      { source: 'Welt/_main.1.fwl2', target: 'Midgard/_main.1.fwl2' },
      { source: 'Welt/_main.1.db2', target: 'Midgard/_main.1.db2' },
    ]);
  });
});

describe('Terraria — einzelne Datei ohne Endung', () => {
  const terraria = () => target('terraria', { worldName: 'welt' });

  it('legt eine .wld unter dem Namen der Instanz ab, ohne Endung', () => {
    expect(mapArchive(['Meine Welt.wld'], terraria())).toEqual([
      { source: 'Meine Welt.wld', target: 'welt' },
    ]);
  });

  it('schneidet eine Hülle ab', () => {
    expect(mapArchive(['Ordner/Meine Welt.wld'], terraria())).toEqual([
      { source: 'Ordner/Meine Welt.wld', target: 'welt' },
    ]);
  });

  it('lehnt zwei Weltdateien ab, statt eine zu raten', () => {
    expect(() => mapArchive(['a.wld', 'b.wld'], terraria())).toThrow(/mehr als eine Datei/);
  });
});

describe('Factorio — die Welt ist selbst ein ZIP', () => {
  it('ordnet einen entpackten Spielstand auf den Namen der Instanz zu', () => {
    // Der Regelfall ist, dass ein `.zip` gar nicht erst entpackt wird; kommt es
    // doch als Archiv an, gilt dieselbe Ein-Datei-Regel wie bei Terraria.
    expect(mapArchive(['anderer-name.zip'], target('factorio', { saveName: 'welt' }))).toEqual([
      { source: 'anderer-name.zip', target: 'welt.zip' },
    ]);
  });
});

describe('Enshrouded — Verzeichnis mit festem Namen', () => {
  it('nimmt den Inhalt unter den festen Namen', () => {
    expect(mapArchive(['savegame/1.db', 'savegame/2.db'], target('enshrouded', {}))).toEqual([
      { source: 'savegame/1.db', target: 'savegame/1.db' },
      { source: 'savegame/2.db', target: 'savegame/2.db' },
    ]);
  });
});
