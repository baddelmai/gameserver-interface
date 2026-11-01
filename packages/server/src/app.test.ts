import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import type { WorldInfo } from '@gsp/shared';
import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { FakeRuntime } from './runtime/fake.js';

/** Ein ZIP im Speicher, aus einer Namen-zu-Inhalt-Tabelle. */
async function zipBuffer(files: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(content, 'utf8'), name);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Multipart-Körper von Hand. `form-data` wäre eine Abhängigkeit für genau
 * diesen einen Test; der Aufbau ist überschaubar genug.
 *
 * Das Textfeld steht **vor** der Datei — der Server liest es aus `file.fields`,
 * und die sind erst gefüllt, wenn sie vorher kamen.
 */
function multipart(
  fields: Record<string, string>,
  upload: { name: string; fileName: string; content: Buffer },
): { body: Buffer; headers: Record<string, string> } {
  const CRLF = '\r\n';
  const boundary = `----gsptest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${upload.name}"; filename="${upload.fileName}"${CRLF}` +
        `Content-Type: application/octet-stream${CRLF}${CRLF}`,
    ),
    upload.content,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  );

  const body = Buffer.concat(chunks);
  return {
    body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  };
}

/**
 * Durchlauf durch die gesamte API gegen die Fake-Laufzeit: anlegen, steuern,
 * sichern, wiederherstellen, löschen — ohne laufenden Docker-Daemon.
 */
describe('API-Durchlauf', () => {
  let app: App;
  let dataDir: string;
  let cookie = '';
  let csrf = '';
  let instanceId = '';

  const headersFor = (withCsrf = true) => ({
    cookie,
    ...(withCsrf ? { 'x-csrf-token': csrf } : {}),
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'gsp-test-'));
    app = await buildApp(
      loadConfig({
        GSP_DATA_DIR: dataDir,
        GSP_RUNTIME: 'fake',
        GSP_PUBLIC_HOST: 'testhost',
        GSP_LOG_LEVEL: 'silent',
        TZ: 'Europe/Berlin',
      }),
      // Ohne Startverzögerung und ohne simulierten Pull, damit Tests nicht warten müssen.
      new FakeRuntime(0, 0),
    );
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('meldet, dass noch kein Konto existiert', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/auth/state' });
    expect(response.json()).toEqual({ needsSetup: true });
  });

  it('sperrt die API ohne Anmeldung', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/instances' });
    expect(response.statusCode).toBe(401);
  });

  it('lehnt zu kurze Passwörter bei der Ersteinrichtung ab', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'kurz' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('legt das erste Konto an und setzt ein Sitzungscookie', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'ein-langes-passwort' },
    });
    expect(response.statusCode).toBe(200);
    csrf = response.json<{ csrfToken: string }>().csrfToken;
    const gesetzt = response.headers['set-cookie'];
    cookie = String(Array.isArray(gesetzt) ? gesetzt[0] : gesetzt).split(';')[0] ?? '';
    expect(cookie).toContain('gsp_session=');
  });

  it('lässt kein zweites Konto über die Einrichtung zu', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'zweiter', password: 'ein-langes-passwort' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('weist schreibende Anfragen ohne CSRF-Token ab', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/instances',
      headers: { cookie },
      payload: { game: 'minecraft', name: 'X' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('liefert die mitgelieferten Vorlagen in der vorgesehenen Reihenfolge', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/templates', headers: headersFor(false) });
    const ids = response.json<{ templates: { id: string }[] }>().templates.map((t) => t.id);
    // Reihenfolge des Startbestands, nicht alphabetisch — so erscheinen sie im Wizard.
    expect(ids.slice(0, 3)).toEqual(['minecraft', 'minecraft-bedrock', 'valheim']);
    expect(ids).toContain('factorio');
    expect(ids.length).toBeGreaterThanOrEqual(7);
  });

  it('legt eine Minecraft-Instanz an und startet sie', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/instances',
      headers: headersFor(),
      payload: {
        game: 'minecraft',
        name: 'Nordheim',
        ports: [{ name: 'game', host: 25565 }],
        memoryMb: 4096,
        cpus: 2,
        settings: { serverName: 'Nordheim', levelName: 'welt', maxPlayers: 20 },
        backupCron: '0 4 * * *',
        backupKeepDays: 7,
      },
    });
    expect(response.statusCode).toBe(201);
    instanceId = response.json<{ id: string }>().id;

    // Der Anlege-Job läuft im Hintergrund; kurz auf „Online“ warten.
    await warteAuf(async () => {
      const detail = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}`,
        headers: headersFor(false),
      });
      return detail.json<{ status: string }>().status === 'Online';
    });
  });

  it('weist einen bereits belegten Port ab', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/instances',
      headers: headersFor(),
      payload: {
        game: 'minecraft',
        name: 'Zweiter',
        ports: [{ name: 'game', host: 25565 }],
        memoryMb: 2048,
        cpus: 1,
        settings: { serverName: 'Zweiter', levelName: 'welt2' },
        backupCron: '',
        backupKeepDays: 7,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('25565');
  });

  it('schlägt freie Ports vor, die noch nicht belegt sind', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/templates/minecraft/ports',
      headers: headersFor(false),
    });
    expect(response.json<{ ports: { game: number } }>().ports.game).toBe(25566);
  });

  it('maskiert Geheimnisse in der Instanzansicht', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/instances',
      headers: headersFor(),
      payload: {
        game: 'valheim',
        name: 'Midgard',
        ports: [{ name: 'game', host: 2456 }, { name: 'query', host: 2457 }],
        memoryMb: 2048,
        cpus: 1,
        settings: { serverName: 'Midgard', worldName: 'Midgard', password: 'sicher123' },
        backupCron: '',
        backupKeepDays: 7,
      },
    });
    const id = response.json<{ id: string }>().id;
    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/instances/${id}`,
      headers: headersFor(false),
    });
    expect(detail.json<{ settings: Record<string, string> }>().settings.password).toBe('********');
    // Das RCON-Passwort taucht nirgends in der Antwort auf.
    expect(detail.body).not.toContain('sicher123');
  });

  it('lehnt Konsolenbefehle bei Vorlagen ohne RCON ab', async () => {
    const list = await app.server.inject({ method: 'GET', url: '/api/instances', headers: headersFor(false) });
    const valheim = list
      .json<{ instances: { id: string; game: string }[] }>()
      .instances.find((i) => i.game === 'valheim');

    const response = await app.server.inject({
      method: 'POST',
      url: `/api/instances/${valheim?.id}/command`,
      headers: headersFor(),
      payload: { command: 'save' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('RCON');
  });

  it('erstellt ein Backup und stellt es wieder her', async () => {
    // Weltdaten anlegen, damit das Archiv Inhalt hat.
    const worldDir = join(dataDir, 'instances', instanceId, 'data', 'welt');
    mkdirSync(worldDir, { recursive: true });
    writeFileSync(join(worldDir, 'level.dat'), 'weltdaten');

    const created = await app.server.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/backups`,
      headers: headersFor(),
    });
    expect(created.statusCode).toBe(200);

    await warteAuf(async () => {
      const list = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/backups`,
        headers: headersFor(false),
      });
      return list.json<{ backups: unknown[] }>().backups.length > 0;
    });

    const list = await app.server.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}/backups`,
      headers: headersFor(false),
    });
    const backup = list.json<{ backups: { id: string; file: string; kind: string }[] }>().backups[0]!;
    expect(backup.kind).toBe('manuell');
    // Dateiname nach dem Muster aus dem Design.
    expect(backup.file).toMatch(/^nordheim-\d{4}-\d{2}-\d{2}-\d{4}-manuell\.tar\.zst$/);

    // Welt löschen und aus dem Backup zurückholen.
    rmSync(worldDir, { recursive: true, force: true });
    const restored = await app.server.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/backups/${backup.id}/restore`,
      headers: headersFor(),
    });
    expect(restored.statusCode).toBe(200);

    await warteAuf(async () => {
      const { existsSync } = await import('node:fs');
      return existsSync(join(worldDir, 'level.dat'));
    });
  });

  describe('Welt', () => {
    const worldDir = () => join(dataDir, 'instances', instanceId, 'data', 'welt');

    it('meldet Weltname, Größe und fehlende Teile', async () => {
      mkdirSync(worldDir(), { recursive: true });
      writeFileSync(join(worldDir(), 'level.dat'), 'weltdaten');

      const response = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/world`,
        headers: headersFor(false),
      });
      expect(response.statusCode).toBe(200);

      const world = response.json<{ world: WorldInfo }>().world;
      expect(world.name).toBe('welt');
      expect(world.nameField).toBe('levelName');
      expect(world.sizeBytes).toBeGreaterThan(0);
      expect(world.raw).toBe(false);
      // Fehlende Dimensionen werden gezeigt, nicht verschwiegen.
      expect(world.parts.map((t) => [t.name, t.present])).toEqual([
        ['welt', true],
        ['welt_nether', false],
        ['welt_the_end', false],
      ]);
    });

    it('liefert die Welt als ZIP mit lesbarem Dateinamen', async () => {
      const response = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/world/download`,
        headers: headersFor(false),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/zip');
      // Beide Formen nach RFC 6266 — der ASCII-Notnagel und der echte Name.
      expect(String(response.headers['content-disposition'])).toMatch(
        /attachment; filename="nordheim-welt-.*\.zip"; filename\*=UTF-8''/,
      );
      // Ein ZIP beginnt mit der lokalen Dateikopf-Signatur.
      expect(response.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    });

    it('verweigert den Austausch, solange die Instanz läuft', async () => {
      const form = await worldForm();
      const response = await app.server.inject({
        method: 'POST',
        url: `/api/instances/${instanceId}/world`,
        headers: { ...headersFor(), ...form.headers },
        payload: form.body,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toMatch(/gestoppt/);
    });

    it('tauscht die Welt bei gestoppter Instanz aus und sichert vorher', async () => {
      await app.server.inject({
        method: 'POST',
        url: `/api/instances/${instanceId}/stop`,
        headers: headersFor(),
      });

      const before = await backupCount();
      const form = await worldForm();
      const response = await app.server.inject({
        method: 'POST',
        url: `/api/instances/${instanceId}/world`,
        headers: { ...headersFor(), ...form.headers },
        payload: form.body,
      });
      expect(response.statusCode).toBe(200);

      await warteAuf(async () => {
        const job = await app.server.inject({
          method: 'GET',
          url: `/api/jobs/${response.json<{ job: { id: string } }>().job.id}`,
          headers: headersFor(false),
        });
        return job.json<{ status: string }>().status !== 'running';
      });

      expect(readFileSync(join(worldDir(), 'level.dat'), 'utf8')).toBe('ersetzt');
      // Die Sicherung vor dem Überschreiben ist die einzige Umkehr.
      expect(await backupCount()).toBeGreaterThan(before);

      await app.server.inject({
        method: 'POST',
        url: `/api/instances/${instanceId}/start`,
        headers: headersFor(),
      });
    });

    it('lehnt eine Datei mit unpassender Endung ab', async () => {
      const form = await worldForm('welt.exe');
      const response = await app.server.inject({
        method: 'POST',
        url: `/api/instances/${instanceId}/world`,
        headers: { ...headersFor(), ...form.headers },
        payload: form.body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toMatch(/zulässig/);
    });

    /*
     * Ein ZIP, dessen Weltordner absichtlich anders heißt als der der Instanz —
     * so belegt der Test zugleich, dass umbenannt wird.
     */
    async function worldForm(fileName = 'fremde-welt.zip') {
      const content = await zipBuffer({ 'neue-welt/level.dat': 'ersetzt' });
      return multipart({ backup: 'true' }, { name: 'file', fileName, content });
    }

    async function backupCount(): Promise<number> {
      const list = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/backups`,
        headers: headersFor(false),
      });
      return list.json<{ backups: unknown[] }>().backups.length;
    }
  });

  describe('Konfigurationsdateien', () => {
    const propertiesPath = () => join(dataDir, 'instances', instanceId, 'data', 'server.properties');

    it('listet, liest und speichert eine Datei im Volume', async () => {
      writeFileSync(propertiesPath(), 'motd=Hallo\nmax-players=20\n');

      const listing = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/files?volume=data`,
        headers: headersFor(false),
      });
      expect(listing.statusCode).toBe(200);
      expect(listing.json<{ entries: { name: string }[] }>().entries.map((e) => e.name)).toContain(
        'server.properties',
      );

      const read = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/files/content?volume=data&path=server.properties`,
        headers: headersFor(false),
      });
      expect(read.statusCode).toBe(200);
      const file = read.json<{ content: string; rev: string }>();
      expect(file.content).toContain('motd=Hallo');

      const saved = await app.server.inject({
        method: 'PUT',
        url: `/api/instances/${instanceId}/files/content`,
        headers: headersFor(),
        payload: {
          volume: 'data',
          path: 'server.properties',
          content: file.content.replace('Hallo', 'Servus'),
          rev: file.rev,
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(readFileSync(propertiesPath(), 'utf8')).toContain('motd=Servus');

      // Mit dem alten Stand noch einmal: das wäre ein stilles Überschreiben.
      const stale = await app.server.inject({
        method: 'PUT',
        url: `/api/instances/${instanceId}/files/content`,
        headers: headersFor(),
        payload: { volume: 'data', path: 'server.properties', content: 'motd=Alt\n', rev: file.rev },
      });
      expect(stale.statusCode).toBe(409);

      // Die Bearbeitung steht im Ereignisprotokoll der Instanz.
      const detail = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}`,
        headers: headersFor(false),
      });
      expect(detail.json<{ events: { text: string }[] }>().events.map((e) => e.text)).toContain(
        'server.properties von Hand bearbeitet',
      );
    });

    it('verlangt auch beim Speichern einer Datei den CSRF-Token', async () => {
      const response = await app.server.inject({
        method: 'PUT',
        url: `/api/instances/${instanceId}/files/content`,
        headers: headersFor(false),
        payload: { volume: 'data', path: 'server.properties', content: 'x', rev: 'x' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('antwortet auf unbekannte Volumes und Ausbruchsversuche mit Fehlern statt Inhalten', async () => {
      const unknown = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/files?volume=etc`,
        headers: headersFor(false),
      });
      expect(unknown.statusCode).toBe(404);

      const traversal = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/files/content?volume=data&path=../../../panel.db`,
        headers: headersFor(false),
      });
      expect(traversal.statusCode).toBe(400);
    });
  });

  describe('Portbereiche (Bedrock über NetherNet)', () => {
    const createBedrock = async (name: string, ports: { name: string; host: number }[]) =>
      app.server.inject({
        method: 'POST',
        url: '/api/instances',
        headers: headersFor(),
        payload: { game: 'minecraft-bedrock', name, ports, memoryMb: 2048, cpus: 2, settings: {} },
      });

    const suggestion = async () =>
      (
        await app.server.inject({
          method: 'GET',
          url: '/api/templates/minecraft-bedrock/ports',
          headers: headersFor(false),
        })
      ).json<{ ports: Record<string, number> }>().ports;

    it('schlägt für eine zweite Instanz einen Bereich vor, der den ersten nicht überlappt', async () => {
      const first = await suggestion();
      expect(first).toEqual({ game: 19132, udp: 19140 });
      const created = await createBedrock('Inselreich', Object.entries(first).map(([name, host]) => ({ name, host })));
      expect(created.statusCode).toBe(201);

      // 19140–19159 sind belegt; der nächste freie Bereich beginnt danach.
      const second = await suggestion();
      expect(second.udp).toBe(19160);
    });

    it('weist einen Bereich ab, der in einen belegten hineinragt', async () => {
      const response = await createBedrock('Kollision', [
        { name: 'game', host: 19133 },
        { name: 'udp', host: 19130 },
      ]);
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toMatch(/19132|1914\d/);
    });

    it('trägt einer alten Instanz beim Neuaufbau einen freien UDP-Bereich nach', async () => {
      const store = app.services.store;
      const old = store.listInstances().find((i) => i.name === 'Inselreich')!;
      // So sah eine Bedrock-Instanz vor NetherNet aus: nur der Spielport.
      store.updateInstance(old.id, { ports: { game: old.ports.game! } });

      // Speichern mit Neustart erzeugt den Container neu.
      const saved = await app.server.inject({
        method: 'PATCH',
        url: `/api/instances/${old.id}/settings`,
        headers: headersFor(),
        payload: { settings: { maxPlayers: 8 }, restart: true },
      });
      expect(saved.statusCode).toBe(200);
      const ports = store.getInstance(old.id)!.ports;
      expect(ports.game).toBe(old.ports.game);
      expect(ports.udp).toBeGreaterThanOrEqual(19140);
    });
  });

  it('speichert geänderte Einstellungen und erzeugt den Container neu', async () => {
    const response = await app.server.inject({
      method: 'PATCH',
      url: `/api/instances/${instanceId}/settings`,
      headers: headersFor(),
      payload: { settings: { maxPlayers: 32, difficulty: 'hard' }, restart: true },
    });
    expect(response.statusCode).toBe(200);

    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}`,
      headers: headersFor(false),
    });
    expect(detail.json<{ settings: { maxPlayers: number } }>().settings.maxPlayers).toBe(32);
  });

  it('ignoriert Änderungen an nicht editierbaren Feldern', async () => {
    await app.server.inject({
      method: 'PATCH',
      url: `/api/instances/${instanceId}/settings`,
      headers: headersFor(),
      payload: { settings: { levelName: 'andere-welt' }, restart: false },
    });
    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}`,
      headers: headersFor(false),
    });
    // `levelName` ist als nicht editierbar gekennzeichnet — der Weltname bleibt.
    expect(detail.json<{ settings: { levelName: string } }>().settings.levelName).toBe('welt');
  });

  it('stoppt und löscht eine Instanz', async () => {
    const gestoppt = await app.server.inject({
      method: 'POST',
      url: `/api/instances/${instanceId}/stop`,
      headers: headersFor(),
    });
    expect(gestoppt.statusCode).toBe(200);

    const deleted = await app.server.inject({
      method: 'DELETE',
      url: `/api/instances/${instanceId}?data=true`,
      headers: headersFor(),
    });
    expect(deleted.statusCode).toBe(200);

    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/instances/${instanceId}`,
      headers: headersFor(false),
    });
    expect(detail.statusCode).toBe(404);
  });

  // --- Vorlagenverwaltung ---------------------------------------------------

  it('antwortet auf eine unbekannte Vorlage mit 404 statt abzustürzen', async () => {
    // Vor dem Umbau war `GameId` ein Enum und dieser Fall unmöglich; seit
    // Vorlagen anlegbar sind, ist er ein normaler Zustand.
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/templates/gibtsnicht/ports',
      headers: headersFor(false),
    });
    expect(response.statusCode).toBe(404);
  });

  it('legt eine eigene Vorlage an, nutzt sie und lehnt das Löschen dann ab', async () => {
    const angelegt = await app.server.inject({
      method: 'POST',
      url: '/api/templates',
      headers: headersFor(),
      payload: customTemplate(),
    });
    expect(angelegt.statusCode, angelegt.body).toBe(201);

    // Sie steht sofort im Wizard.
    const list = await app.server.inject({ method: 'GET', url: '/api/templates', headers: headersFor(false) });
    expect(list.json<{ templates: { id: string }[] }>().templates.map((t) => t.id)).toContain('kartoffelkrieg');

    // Und eine Instanz daraus lässt sich anlegen.
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/instances',
      headers: headersFor(),
      payload: {
        game: 'kartoffelkrieg',
        name: 'Acker',
        ports: [{ name: 'game', host: 7777 }],
        memoryMb: 2048,
        cpus: 2,
        settings: { world: 'Acker' },
        backupCron: '0 4 * * *',
        backupKeepDays: 7,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const newId = created.json<{ id: string }>().id;

    // Erst abwarten, bis der Anlege-Job durch ist. Wird die Instanz vorher
    // gelöscht, schreibt der Job noch, wenn `afterAll` die Datenbank schließt.
    await warteAuf(async () => {
      const detail = await app.server.inject({
        method: 'GET',
        url: `/api/instances/${newId}`,
        headers: headersFor(false),
      });
      return detail.json<{ status: string }>().status === 'Online';
    });

    const gesperrt = await app.server.inject({
      method: 'DELETE',
      url: '/api/templates/kartoffelkrieg',
      headers: headersFor(),
    });
    expect(gesperrt.statusCode).toBe(400);
    expect(gesperrt.json<{ error: string }>().error).toMatch(/genutzt/);

    await app.server.inject({
      method: 'DELETE',
      url: `/api/instances/${newId}?data=true`,
      headers: headersFor(),
    });
    const deleted = await app.server.inject({
      method: 'DELETE',
      url: '/api/templates/kartoffelkrieg',
      headers: headersFor(),
    });
    expect(deleted.statusCode).toBe(200);
  });

  it('lehnt eine unschlüssige Vorlage mit Feldfehlern ab', async () => {
    const broken = customTemplate();
    broken.env = [{ name: 'X', source: { kind: 'field', field: 'gibtsNicht' }, trim: false, omitWhenEmpty: false }];
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/templates',
      headers: headersFor(),
      payload: broken,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ fields: { message: string }[] }>().fields[0]?.message).toMatch(/Unbekanntes Feld/);
  });

  it('meldet den KI-Entwurf ohne Schlüssel als nicht verfügbar', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/templates/ki/status',
      headers: headersFor(false),
    });
    expect(response.json<{ available: boolean }>().available).toBe(false);

    const versuch = await app.server.inject({
      method: 'POST',
      url: '/api/templates/ki/entwurf',
      headers: headersFor(),
      payload: { game: 'Irgendwas', image: 'beispiel/image' },
    });
    expect(versuch.statusCode).toBe(503);
  });

  /**
   * Mit Schlüssel meldet die Statusroute `available` und die Oberfläche zeigt
   * den Knopf. Ein echter Aufruf findet nicht statt — geprüft ist damit die
   * Verdrahtung von Umgebungsvariable bis Route, nicht der Gemini-Aufruf selbst.
   */
  it('schaltet den KI-Entwurf frei, sobald ein Schlüssel hinterlegt ist', async () => {
    const verzeichnis = mkdtempSync(join(tmpdir(), 'gsp-ki-'));
    const withKey = await buildApp(
      loadConfig({
        GSP_DATA_DIR: verzeichnis,
        GSP_RUNTIME: 'fake',
        GSP_LOG_LEVEL: 'silent',
        GSP_GEMINI_API_KEY: 'test-schluessel',
        GSP_GEMINI_MODELL: 'gemini-test',
        TZ: 'Europe/Berlin',
      }),
      new FakeRuntime(0, 0),
    );

    try {
      const status = withKey.services.drafts.status();
      expect(status.available).toBe(true);
      expect(status.model).toBe('gemini-test');
    } finally {
      await withKey.close();
      rmSync(verzeichnis, { recursive: true, force: true });
    }
  });

  it('markiert Instanzen, deren Vorlage sich geändert hat', async () => {
    // Die Minecraft-Instanz ist zu diesem Zeitpunkt gelöscht; die Valheim-Instanz
    // aus dem Maskierungstest besteht noch.
    const list = await app.server.inject({ method: 'GET', url: '/api/instances', headers: headersFor(false) });
    const valheim = list
      .json<{ instances: { id: string; game: string; templateStale: boolean }[] }>()
      .instances.find((i) => i.game === 'valheim');
    expect(valheim?.templateStale).toBe(false);

    const definition = (
      await app.server.inject({
        method: 'GET',
        url: '/api/templates/valheim/definition',
        headers: headersFor(false),
      })
    ).json<{ definition: Record<string, unknown> }>().definition;

    const gespeichert = await app.server.inject({
      method: 'PUT',
      url: '/api/templates/valheim',
      headers: headersFor(),
      payload: { ...definition, defaultMemoryMb: 12288 },
    });
    expect(gespeichert.statusCode, gespeichert.body).toBe(200);

    const after = await app.server.inject({
      method: 'GET',
      url: `/api/instances/${valheim?.id}`,
      headers: headersFor(false),
    });
    // Die Instanz läuft unverändert weiter — erst ein Neuaufbau übernimmt den Stand.
    expect(after.json<{ templateStale: boolean }>().templateStale).toBe(true);
    expect(after.json<{ status: string }>().status).not.toBe('Fehler');
  });
});

/** Minimale, gültige Vorlage für die Routentests. */
function customTemplate(): Record<string, unknown> {
  return {
    id: 'kartoffelkrieg',
    label: 'Kartoffelkrieg',
    summary: 'Nur für Tests.',
    image: 'beispiel/kartoffelkrieg',
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
        id: 'world', label: 'Welt', type: 'text', default: 'Acker',
        required: true, editable: true, restartRequired: true, secret: false,
      },
    ],
    env: [{ name: 'WORLD', source: { kind: 'field', field: 'world' }, trim: false, omitWhenEmpty: false }],
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

/** Wartet, bis eine Bedingung zutrifft — für Aktionen, die als Job laufen. */
async function warteAuf(bedingung: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const ende = Date.now() + timeoutMs;
  while (Date.now() < ende) {
    if (await bedingung()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Bedingung wurde nicht rechtzeitig erfüllt');
}
