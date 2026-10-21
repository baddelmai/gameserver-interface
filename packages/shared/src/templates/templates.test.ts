import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_DEFINITIONS,
  DEFAULT_FAKE_LOG,
  compileTemplate,
  defaultValues,
  getTemplate,
  listTemplates,
  loadBuiltinTemplates,
  renderFakeLine,
  toDescriptor,
  validateSettings,
} from './index.js';
import { terrariaDefinition } from './terraria.js';
import type { TemplateContext } from '../schema/template.js';

const ctx: TemplateContext = {
  hostPorts: { game: 25565, query: 2457 },
  rconPassword: 'geheim123',
  timezone: 'Europe/Berlin',
};

// Vorlagen liegen jetzt in einer Registry, die der Server aus der Datenbank
// füllt. Für Tests genügt der eingebaute Startbestand.
beforeAll(() => {
  loadBuiltinTemplates();
});

describe('Vorlagen', () => {
  it('liefert für jedes Spiel eine Vorlage mit eindeutigen Feld- und Port-Namen', () => {
    for (const template of listTemplates()) {
      const fieldIds = template.fields.map((f) => f.id);
      expect(new Set(fieldIds).size, `${template.id}: doppelte Feld-ID`).toBe(fieldIds.length);

      const portNames = template.ports.map((p) => p.name);
      expect(new Set(portNames).size, `${template.id}: doppelter Port-Name`).toBe(portNames.length);
    }
  });

  it('gibt nur Vorlagen mit Mod-Pfad als mod-fähig aus', () => {
    for (const template of listTemplates()) {
      const hasPath = template.modsPath !== undefined;
      expect(hasPath, `${template.id}`).toBe(template.capabilities.mods !== 'none');
    }
  });

  it('sichert nur Pfade, die in einem Volume der Vorlage liegen', () => {
    for (const template of listTemplates()) {
      for (const path of template.backup.paths) {
        const inVolume = template.volumes.some((v) => path.startsWith(v.containerPath));
        expect(inVolume, `${template.id}: ${path} liegt in keinem Volume`).toBe(true);
      }
    }
  });

  it('setzt Vorbefehle nur, wo eine schreibbare Konsole existiert', () => {
    for (const template of listTemplates()) {
      if ((template.backup.preCommands ?? []).length > 0) {
        expect(template.capabilities.console, template.id).toBe('rcon');
      }
    }
  });

  it('benennt die Weltdaten innerhalb eines Volumes und innerhalb der Backup-Pfade', () => {
    for (const template of listTemplates()) {
      const world = template.world;
      if (!world) continue;
      const inVolume = template.volumes.some((v) => world.parent.startsWith(v.containerPath));
      expect(inVolume, `${template.id}: ${world.parent} liegt in keinem Volume`).toBe(true);

      // Sonst wäre die Sicherung vor dem Austausch wertlos.
      const path =
        world.name.kind === 'const' ? `${world.parent}/${world.name.value}` : world.parent;
      const covered = template.backup.paths.some((p) => path === p || path.startsWith(`${p}/`));
      expect(covered, `${template.id}: ${path} wird von keinem Backup-Pfad abgedeckt`).toBe(true);

      expect(world.parts[0]?.required, `${template.id}: erster Teil nicht erforderlich`).toBe(true);
    }
  });

  it('nennt zu jedem Weltnamensfeld ein Feld, das es gibt', () => {
    for (const template of listTemplates()) {
      const name = template.world?.name;
      if (name?.kind !== 'field') continue;
      const field = template.fields.some((f) => f.id === name.field);
      expect(field, `${template.id}: Feld ${name.field} fehlt`).toBe(true);
    }
  });

  /*
   * Ausdrücklich aufgezählt, damit eine neue Vorlage hier auffällt statt
   * stillschweigend ohne Welt-Reiter zu erscheinen.
   *
   * Die Liste ist keine Endgültigkeit: bei diesen Spielen liegt die Welt in
   * einem Verzeichnis, das auch Serverkonfiguration und Spielerprofile enthält
   * (ARK, Zomboid, Palworld, Satisfactory, Rust, V Rising, 7 Days to Die, DST,
   * Core Keeper, Barotrauma), oder es gibt gar keine Welt (CS2, TF2, Garry's
   * Mod, die nur cfg-Verzeichnisse sichern). Ein Welt-Reiter über einer
   * Serverkonfiguration verspräche etwas Falsches. Wer den Pfad an einem
   * laufenden Server belegt, trägt hier einen Block nach und streicht die Zeile.
   */
  it('führt die Vorlagen ohne Weltangabe namentlich', () => {
    const withoutWorld = listTemplates()
      .filter((t) => t.world === undefined)
      .map((t) => t.id)
      .sort();
    expect(withoutWorld).toEqual([
      '7daystodie',
      'ark',
      'barotrauma',
      'corekeeper',
      'cs2',
      'dst',
      'garrysmod',
      'palworld',
      'rust',
      'satisfactory',
      'tf2',
      'vrising',
      'zomboid',
    ]);
  });

  it('trägt die Weltangabe in den Descriptor', () => {
    expect(toDescriptor(getTemplate('minecraft')).world?.parent).toBe('/data');
    expect(toDescriptor(getTemplate('cs2')).world).toBeUndefined();
  });

  it('entfernt beim Descriptor die nicht serialisierbaren Teile', () => {
    const descriptor = toDescriptor(getTemplate('minecraft'));
    expect(JSON.stringify(descriptor)).toContain('minecraft');
    expect('env' in descriptor).toBe(false);
    expect('logPatterns' in descriptor).toBe(false);
  });
});

describe('Umgebungsvariablen', () => {
  it('akzeptiert die Minecraft-EULA und übernimmt das RCON-Passwort', () => {
    const env = getTemplate('minecraft').env(
      { ...defaultValues(getTemplate('minecraft')), maxPlayers: 24, difficulty: 'hard' },
      ctx,
    );
    expect(env.EULA).toBe('TRUE');
    expect(env.ENABLE_RCON).toBe('TRUE');
    expect(env.RCON_PASSWORD).toBe('geheim123');
    expect(env.MAX_PLAYERS).toBe('24');
    expect(env.DIFFICULTY).toBe('hard');
  });

  it('lässt SEED weg, wenn kein Seed gesetzt ist', () => {
    const template = getTemplate('minecraft');
    expect(template.env({ ...defaultValues(template), seed: '' }, ctx).SEED).toBeUndefined();
    expect(template.env({ ...defaultValues(template), seed: 'abc' }, ctx).SEED).toBe('abc');
  });

  it('schaltet die bildeigenen Valheim-Backups ab, weil das Panel sie übernimmt', () => {
    const env = getTemplate('valheim').env(defaultValues(getTemplate('valheim')), ctx);
    expect(env.BACKUPS).toBe('false');
  });

  it('bildet Enshrouded-Zugänge auf Server-Rollen ab und lässt leere Rollen aus', () => {
    const template = getTemplate('enshrouded');
    const env = template.env(
      { ...defaultValues(template), adminPassword: 'admin1', guestPassword: '' },
      ctx,
    );
    expect(env.SERVER_ROLE_0_NAME).toBe('Admin');
    expect(env.SERVER_ROLE_0_PASSWORD).toBe('admin1');
    expect(env.SERVER_ROLE_2_PASSWORD).toBeUndefined();
    // Ohne explizite Rechte legt das Image die Gruppen rechtelos an.
    expect(env.SERVER_ROLE_0_CAN_KICK_BAN).toBe('true');
    expect(env.SERVER_ROLE_0_CAN_ACCESS_INVENTORIES).toBe('true');
    expect(env.SERVER_ROLE_0_CAN_EDIT_BASE).toBe('true');
    expect(env.SERVER_ROLE_0_CAN_EXTEND_BASE).toBe('true');
    expect(env.SERVER_ROLE_1_CAN_KICK_BAN).toBe('false');
    expect(env.SERVER_ROLE_2_CAN_ACCESS_INVENTORIES).toBe('false');
    // Enshrouded nutzt nur noch den Query-Port.
    expect(env.SERVER_QUERYPORT).toBe('2457');
  });
});

describe('Validierung', () => {
  it('lehnt zu kurze Valheim-Passwörter ab', () => {
    const template = getTemplate('valheim');
    const errors = validateSettings(template, {
      ...defaultValues(template),
      serverName: 'Test',
      worldName: 'Welt',
      password: 'abc',
    });
    expect(errors.some((f) => f.field === 'password')).toBe(true);
  });

  it('lehnt ein Valheim-Passwort ab, das im Servernamen vorkommt', () => {
    const template = getTemplate('valheim');
    const errors = validateSettings(template, {
      ...defaultValues(template),
      serverName: 'geheim-server',
      worldName: 'Welt',
      password: 'geheim',
    });
    expect(errors.map((f) => f.message).join()).toContain('Server- oder Weltnamen');
  });

  it('verlangt für Enshrouded ein Admin-Passwort', () => {
    const template = getTemplate('enshrouded');
    const errors = validateSettings(template, { ...defaultValues(template), adminPassword: '' });
    expect(errors.some((f) => f.field === 'adminPassword')).toBe(true);
  });

  it('lehnt Weltnamen mit Pfadanteilen ab', () => {
    const template = getTemplate('minecraft');
    const errors = validateSettings(template, {
      ...defaultValues(template),
      levelName: '../../etc',
    });
    expect(errors.some((f) => f.field === 'levelName')).toBe(true);
  });

  it('akzeptiert gültige Standardwerte für alle Vorlagen', () => {
    const gueltig: Record<string, Record<string, string>> = {
      minecraft: {},
      valheim: { password: 'sicher123' },
      enshrouded: { adminPassword: 'admin123' },
      // Rust hat kein erzeugtes Geheimnis: sein Web-RCON braucht ein Passwort,
      // das der Betreiber selbst kennt.
      rust: { rconPassword: 'sicher123' },
      zomboid: { adminPassword: 'sicher123' },
      dst: { clusterToken: 'pds-g^abcdefghi-q^jklmnopqrstuvwxyz0123456789=' },
    };
    for (const template of listTemplates()) {
      const values = { ...defaultValues(template), ...gueltig[template.id] };
      expect(validateSettings(template, values), template.id).toEqual([]);
    }
  });
});

/**
 * Bis zu diesem Umbau lagen die Log-Muster in den Vorlagen und die simulierten
 * Zeilen der Fake-Runtime in einer eigenen Tabelle im Server-Paket. Wer eines
 * änderte und das andere vergaß, hatte grüne Tests und eine Produktion, die
 * keine Spieler mehr erkannte — `CLAUDE.md` warnte ausdrücklich davor.
 *
 * Seit beides in derselben Definition steht, lässt sich das prüfen statt
 * dokumentieren.
 */
describe('Simulierte Logzeilen passen zu den Mustern derselben Vorlage', () => {
  // Direkt über die Definitionen statt über die Registry: `describe` sammelt
  // seine Fälle ein, bevor `beforeAll` gelaufen ist.
  for (const template of BUILTIN_DEFINITIONS.map(compileTemplate)) {
    it(template.label, () => {
      const spec = template.definition.fakeLog ?? DEFAULT_FAKE_LOG;
      const patterns = template.logPatterns;

      const joinLine = renderFakeLine(spec, 'join', 'Freyja_88', 4711);
      expect(patterns.join.exec(joinLine)?.[1], joinLine).toBe('Freyja_88');

      const readyLine = renderFakeLine(spec, 'ready', '', 1200);
      expect(patterns.ready.test(readyLine), readyLine).toBe(true);

      if (patterns.leave) {
        const leaveLine = renderFakeLine(spec, 'leave', 'Freyja_88', 9001);
        expect(patterns.leave.exec(leaveLine)?.[1], leaveLine).toBe('Freyja_88');
      }

      // Beiläufige Zeilen dürfen keinen Beitritt vortäuschen.
      const geplauder = renderFakeLine(spec, 'chatter', 'Freyja_88', 42);
      expect(patterns.join.test(geplauder), geplauder).toBe(false);
    });
  }
});

describe('Kompilierte Vorlagen', () => {
  it('behalten ihre Definition bei sich', () => {
    for (const definition of BUILTIN_DEFINITIONS) {
      expect(compileTemplate(definition).definition).toEqual(definition);
    }
  });
});

/**
 * Terraria ist die erste Vorlage, die sich nicht allein ueber Umgebungsvariablen
 * einrichten laesst: Das Image kennt nur `WORLD_FILENAME` und `CONFIG_FILENAME`,
 * alles Weitere erwartet der Server als Startargument. Diese Tests halten die
 * Uebersetzung fest — vor allem, dass ein leeres Passwort nicht als leeres
 * Argument durchrutscht und den Server mit `-password ""` starten laesst.
 */
describe('Startargumente', () => {
  const terraria = compileTemplate(terrariaDefinition);
  const ctx = { hostPorts: { game: 7788 }, rconPassword: 'unbenutzt', timezone: 'Europe/Berlin' };
  const vorgaben = Object.fromEntries(terraria.fields.map((f) => [f.id, f.default]));

  it('setzt Flag und Wert als getrennte Elemente', () => {
    const args = terraria.args(vorgaben, ctx);
    expect(args.slice(0, 2)).toEqual(['-autocreate', '2']);
  });

  /*
   * `bootstrap.sh` im Image hängt selbst ein `-world` an, gebildet aus
   * `WORLD_FILENAME`. Ein zweites aus der Vorlage bricht TShock beim Start ab:
   * „An item with the same key has already been added. Key: -world“.
   */
  it('überlässt -world dem Bootstrap-Skript des Images', () => {
    expect(terraria.args(vorgaben, ctx)).not.toContain('-world');
    expect(terraria.env(vorgaben, ctx).WORLD_FILENAME).toBe('welt');
  });

  it('nimmt den tatsaechlich belegten Host-Port, nicht die Vorgabe', () => {
    const args = terraria.args(vorgaben, ctx);
    expect(args[args.indexOf('-port') + 1]).toBe('7788');
  });

  it('laesst ein leeres Passwort samt Flag weg', () => {
    expect(terraria.args(vorgaben, ctx)).not.toContain('-password');
    const mit = terraria.args({ ...vorgaben, password: 'geheim' }, ctx);
    expect(mit.slice(mit.indexOf('-password'))).toEqual(['-password', 'geheim']);
  });

  it('bleibt bei Vorlagen ohne Argumente leer', () => {
    for (const definition of BUILTIN_DEFINITIONS.filter((d) => d.args === undefined)) {
      const t = compileTemplate(definition);
      const ports = Object.fromEntries(t.ports.map((p) => [p.name, p.defaultHost]));
      const values = Object.fromEntries(t.fields.map((f) => [f.id, f.default]));
      expect(t.args(values, { ...ctx, hostPorts: ports }), definition.id).toEqual([]);
    }
  });
});
