import { describe, expect, it } from 'vitest';
import type { FieldValues, TemplateContext } from '../schema/template.js';
import { compileTemplate } from './compile.js';
import { defaultValues } from './index.js';
import { minecraftDefinition } from './minecraft.js';
import { valheimDefinition } from './valheim.js';
import { enshroudedDefinition } from './enshrouded.js';

/**
 * Die Vorlagen waren bis zu diesem Umbau handgeschriebene TypeScript-Objekte
 * mit einer `env()`-Funktion. Unten stehen diese Funktionen **wortgleich** wie
 * vor dem Umbau; die Tests vergleichen sie gegen die kompilierte Definition.
 *
 * Zweck ist nicht, das alte Verhalten für immer festzuschreiben, sondern zu
 * belegen, dass die deklarative Abbildung dasselbe erzeugt — inklusive der
 * Feinheiten, die man beim Übersetzen leicht verliert: `?? '…'`-Vorgaben,
 * `=== false`-Vergleiche, das Trimmen des Seeds und die weggelassenen
 * Variablen. Die Datei darf verschwinden, sobald das Vertrauen groß genug ist.
 */

const ctx: TemplateContext = {
  hostPorts: { game: 27015, query: 27016, rcon: 25575 },
  rconPassword: 'geheim-rcon',
  timezone: 'Europe/Berlin',
};

const ctxWithoutRcon: TemplateContext = { hostPorts: {}, timezone: 'UTC' };

// --- Die alten Funktionen, unverändert übernommen ---------------------------

function altMinecraft(values: FieldValues, c: TemplateContext): Record<string, string> {
  const seed = String(values.seed ?? '').trim();
  const env: Record<string, string> = {
    EULA: 'TRUE',
    TYPE: String(values.type ?? 'PAPER'),
    VERSION: String(values.version ?? 'LATEST'),
    MOTD: String(values.motd ?? ''),
    MAX_PLAYERS: String(values.maxPlayers ?? 20),
    DIFFICULTY: String(values.difficulty ?? 'normal'),
    LEVEL: String(values.levelName ?? 'world'),
    ENABLE_WHITELIST: values.whitelist ? 'TRUE' : 'FALSE',
    PVP: values.pvp === false ? 'FALSE' : 'TRUE',
    ONLINE_MODE: values.onlineMode === false ? 'FALSE' : 'TRUE',
    VIEW_DISTANCE: String(values.viewDistance ?? 10),
    ENABLE_RCON: 'TRUE',
    RCON_PORT: '25575',
    SERVER_PORT: String(c.hostPorts.game ?? 25565),
    TZ: c.timezone,
    ENABLE_AUTOPAUSE: 'FALSE',
    STOP_SERVER_ANNOUNCE_DELAY: '5',
  };
  if (seed) env.SEED = seed;
  if (c.rconPassword) env.RCON_PASSWORD = c.rconPassword;
  return env;
}

function altValheim(values: FieldValues, c: TemplateContext): Record<string, string> {
  return {
    SERVER_NAME: String(values.serverName ?? 'Valheim Server'),
    WORLD_NAME: String(values.worldName ?? 'Dedicated'),
    SERVER_PASS: String(values.password ?? ''),
    SERVER_PORT: String(c.hostPorts.game ?? 2456),
    SERVER_PUBLIC: values.public === false ? 'false' : 'true',
    SERVER_ARGS: values.crossplay === false ? '' : '-crossplay',
    SERVER_PRESET: String(values.preset ?? 'normal'),
    BEPINEX: values.bepinex ? 'true' : 'false',
    BACKUPS: 'false',
    UPDATE_CRON: String(values.updateCron ?? ''),
    TZ: c.timezone,
  };
}

function altEnshrouded(values: FieldValues, c: TemplateContext): Record<string, string> {
  const env: Record<string, string> = {
    SERVER_NAME: String(values.serverName ?? 'Enshrouded Server'),
    SERVER_SLOT_COUNT: String(values.slotCount ?? 16),
    SERVER_IP: '0.0.0.0',
    SERVER_QUERYPORT: String(c.hostPorts.query ?? 15637),
    SERVER_SAVE_DIR: './savegame',
    SERVER_LOG_DIR: './logs',
    SERVER_GAMESETTINGSPRESET: String(values.gameSettingsPreset ?? 'Default'),
    SERVER_ENABLE_VOICE_CHAT: values.voiceChat ? 'true' : 'false',
    SERVER_ENABLE_TEXT_CHAT: values.textChat === false ? 'false' : 'true',
    SERVER_ROLE_0_NAME: 'Admin',
    SERVER_ROLE_1_NAME: 'Friend',
    SERVER_ROLE_2_NAME: 'Guest',
    SERVER_ROLE_0_CAN_KICK_BAN: 'true',
    SERVER_ROLE_0_CAN_ACCESS_INVENTORIES: 'true',
    SERVER_ROLE_0_CAN_EDIT_WORLD: 'true',
    SERVER_ROLE_0_CAN_EDIT_BASE: 'true',
    SERVER_ROLE_0_CAN_EXTEND_BASE: 'true',
    SERVER_ROLE_1_CAN_KICK_BAN: 'false',
    SERVER_ROLE_1_CAN_ACCESS_INVENTORIES: 'true',
    SERVER_ROLE_1_CAN_EDIT_WORLD: 'true',
    SERVER_ROLE_1_CAN_EDIT_BASE: 'true',
    SERVER_ROLE_1_CAN_EXTEND_BASE: 'true',
    SERVER_ROLE_2_CAN_KICK_BAN: 'false',
    SERVER_ROLE_2_CAN_ACCESS_INVENTORIES: 'false',
    SERVER_ROLE_2_CAN_EDIT_WORLD: 'true',
    SERVER_ROLE_2_CAN_EDIT_BASE: 'false',
    SERVER_ROLE_2_CAN_EXTEND_BASE: 'false',
    UPDATE_CRON: String(values.updateCron ?? ''),
    TZ: c.timezone,
  };
  const admin = String(values.adminPassword ?? '');
  const friend = String(values.friendPassword ?? '');
  const guest = String(values.guestPassword ?? '');
  if (admin) env.SERVER_ROLE_0_PASSWORD = admin;
  if (friend) env.SERVER_ROLE_1_PASSWORD = friend;
  if (guest) env.SERVER_ROLE_2_PASSWORD = guest;
  return env;
}

// --- Wertesätze -------------------------------------------------------------

/** Standard, alles leer, alle Booleans invertiert, Ränder. */
function valueSets(definition: Parameters<typeof compileTemplate>[0]): FieldValues[] {
  const template = compileTemplate(definition);
  const defaults = defaultValues(template);

  const inverted: FieldValues = { ...defaults };
  for (const field of template.fields) {
    if (field.type === 'boolean') inverted[field.id] = !(defaults[field.id] as boolean);
  }

  const emptyValues: FieldValues = {};
  for (const field of template.fields) {
    if (field.type === 'boolean') emptyValues[field.id] = false;
    else if (field.type === 'number') emptyValues[field.id] = 0;
    else emptyValues[field.id] = '';
  }

  return [defaults, inverted, emptyValues, {}];
}

describe('Migration: kompilierte Vorlage erzeugt dieselbe Umgebung', () => {
  it('Minecraft', () => {
    const compiled = compileTemplate(minecraftDefinition);
    for (const values of valueSets(minecraftDefinition)) {
      for (const c of [ctx, ctxWithoutRcon]) {
        expect(compiled.env(values, c)).toEqual(altMinecraft(values, c));
      }
    }
  });

  it('Minecraft: Seed wird getrimmt und bei Leerraum weggelassen', () => {
    const compiled = compileTemplate(minecraftDefinition);
    expect(compiled.env({ seed: '  ' }, ctx).SEED).toBeUndefined();
    expect(compiled.env({ seed: '  abc  ' }, ctx).SEED).toBe('abc');
    expect(altMinecraft({ seed: '  ' }, ctx).SEED).toBeUndefined();
    expect(altMinecraft({ seed: '  abc  ' }, ctx).SEED).toBe('abc');
  });

  it('Enshrouded', () => {
    const compiled = compileTemplate(enshroudedDefinition);
    for (const values of valueSets(enshroudedDefinition)) {
      for (const c of [ctx, ctxWithoutRcon]) {
        expect(compiled.env(values, c)).toEqual(altEnshrouded(values, c));
      }
    }
  });

  it('Valheim — bis auf das jetzt optionale Passwort', () => {
    const compiled = compileTemplate(valheimDefinition);
    for (const values of valueSets(valheimDefinition)) {
      for (const c of [ctx, ctxWithoutRcon]) {
        const withPassword = { ...values, password: 'sicheresPasswort' };
        expect(compiled.env(withPassword, c)).toEqual(altValheim(withPassword, c));
      }
    }
  });

  /**
   * Die einzige beabsichtigte Verhaltensänderung des Umbaus: früher schrieb die
   * Vorlage immer ein `SERVER_PASS`, notfalls leer, und das Feld war Pflicht.
   */
  it('Valheim ohne Passwort lässt SERVER_PASS weg, statt es leer zu setzen', () => {
    const compiled = compileTemplate(valheimDefinition);
    const without = { ...defaultValues(compiled), password: '' };

    expect(altValheim(without, ctx).SERVER_PASS).toBe('');
    expect(compiled.env(without, ctx)).not.toHaveProperty('SERVER_PASS');

    const field = compiled.fields.find((f) => f.id === 'password');
    expect(field?.required).toBe(false);
  });
});

describe('Migration: Log-Muster bleiben identisch', () => {
  const expected = [
    {
      name: 'Minecraft',
      definition: minecraftDefinition,
      join: /:\s*([A-Za-z0-9_]{1,16})\[\/[^\]]+\] logged in/,
      leave: /:\s*([A-Za-z0-9_]{1,16}) lost connection/,
      ready: /\]: Done \([\d.]+s\)! For help/,
      clean: (line: string) => line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*\[[^\]]+\]:\s*/, '').trimEnd(),
      samples: [
        '[12:34:56] [Server thread/INFO]: Kai_Baut[/1.2.3.4:5678] logged in with entity id 42',
        '[12:34:56] [Server thread/INFO]: Kai_Baut lost connection: Disconnected',
        '[12:34:56] [Server thread/INFO]: Done (12.000s)! For help, type "help"   ',
      ],
    },
    {
      name: 'Valheim',
      definition: valheimDefinition,
      join: /Got character ZDOID from (\S+)\s*:/,
      leave: undefined,
      ready: /(DungeonDB Start|Game server connected)/,
      clean: (line: string) => line.replace(/^\s*\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}:\s*/, '').trimEnd(),
      samples: [
        '09/09/2026 12:34:56: Got character ZDOID from Freyja_88 : -12345:6',
        '09/09/2026 12:34:56: DungeonDB Start 1200  ',
      ],
    },
    /*
     * Enshrouded ist die eine Ausnahme in dieser Tabelle: seine Muster sind
     * nicht die von vor dem Umbau. Die stammten aus keiner Logzeile, die das
     * Image je geschrieben hat — die Instanz blieb deshalb für immer auf
     * „Startet“. Festgeschrieben ist hier der Stand nach der Korrektur,
     * abgelesen an einem laufenden `mornedhels/enshrouded-server`.
     */
    {
      name: 'Enshrouded',
      definition: enshroudedDefinition,
      join: /\[server\] Player '([^']+)' logged in/,
      leave: /\[server\] Remove Player '([^']+)'/,
      ready: /\[game_server\] Switching state from \S+ to Run\b/,
      clean: (line: string) => line.replace(/^\s*\[?\d{4}-\d{2}-\d{2}[ T][\d:.]+\]?\s*/, '').trimEnd(),
      samples: [
        "2026-09-10 00:37:14.083 supervisord: enshrouded-server [server] Player 'Henner' logged in with Permissions:",
        "2026-09-10 00:37:50.164 supervisord: enshrouded-server [server] Remove Player 'Henner'",
        '2026-09-10 00:38:24.506 supervisord: enshrouded-server [game_server] Switching state from LoadEcsScene to Run after 169.01 ms   ',
      ],
    },
  ];

  for (const testCase of expected) {
    it(testCase.name, () => {
      const compiled = compileTemplate(testCase.definition).logPatterns;

      expect(compiled.join.source).toBe(testCase.join.source);
      expect(compiled.join.flags).toBe(testCase.join.flags);
      expect(compiled.ready.source).toBe(testCase.ready.source);
      expect(compiled.ready.flags).toBe(testCase.ready.flags);
      expect(compiled.leave?.source).toBe(testCase.leave?.source);

      // Nicht nur die Quelltexte, sondern das Ergebnis an echten Zeilen.
      for (const line of testCase.samples) {
        expect(compiled.clean?.(line)).toBe(testCase.clean(line));
        expect(compiled.join.test(line)).toBe(testCase.join.test(line));
        expect(compiled.ready.test(line)).toBe(testCase.ready.test(line));
      }
    });
  }
});
