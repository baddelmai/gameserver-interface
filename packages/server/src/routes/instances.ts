import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
// Erweitert Request um `file()` für den Mod-Upload.
import '@fastify/multipart';
import {
  banRequestSchema,
  commandRequestSchema,
  createInstanceRequestSchema,
  clockHms,
  gameIdSchema,
  getTemplate,
  listTemplates,
  toDescriptor,
  updateSettingsRequestSchema,
  formatBytes,
  saveFileRequestSchema,
  worldUploadOptionsSchema,
} from '@gsp/shared';
import { getAdapter, UnsupportedError } from '../games/index.js';
import type { Store } from '../db/store.js';
import { BackupError, type BackupService } from '../services/backups.js';
import type { InstanceService } from '../services/instances.js';
import { ValidationError } from '../services/instances.js';
import type { JobService } from '../services/jobs.js';
import type { LogService } from '../services/logs.js';
import type { ModService } from '../services/mods.js';
import type { TemplateService } from '../services/templates.js';
import type { Ticker } from '../services/ticker.js';
import { WorldError, type WorldService } from '../services/world.js';
import { FileError, type FileService } from '../services/files.js';
import { needsZip64, packZip, collectEntries } from '../services/world-zip.js';
import type { Config } from '../config.js';
import { slug } from '../services/paths.js';

interface Deps {
  instances: InstanceService;
  store: Store;
  logs: LogService;
  mods: ModService;
  backups: BackupService;
  jobs: JobService;
  ticker: Ticker;
  templates: TemplateService;
  world: WorldService;
  files: FileService;
  config: Config;
}

/**
 * RFC 6266: `filename` ist der ASCII-Notnagel für alte Clients, `filename*`
 * (RFC 5987) trägt den echten Namen. Beide zu setzen ist der einzige Weg, der
 * überall funktioniert — ein Weltname mit Umlaut käme sonst verstümmelt an.
 */
function attachment(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const ascii = `${slug(stem)}${ext.replace(/[^ -~]/g, '')}`;
  // `encodeURIComponent` lässt `!'()*` stehen; RFC 5987 will sie kodiert.
  const encoded = encodeURIComponent(name).replace(
    /['()!*]/g,
    (z) => `%${z.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Wert eines Multipart-Textfelds. */
function fieldValue(fields: unknown, name: string): string | undefined {
  const entry = (fields as Record<string, { value?: unknown } | undefined>)[name];
  return typeof entry?.value === 'string' ? entry.value : undefined;
}

export async function instanceRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { instances, store, logs, mods, backups, jobs, ticker, templates, world, files, config } = deps;

  /** Bricht mit 404 ab, wenn die Instanz nicht existiert. */
  const need = (id: string) => {
    const instance = instances.get(id);
    if (!instance) throw new ValidationError('Instanz nicht gefunden');
    return instance;
  };

  app.get('/api/host', async () => ticker.hostStatus());

  app.get('/api/templates', async () => ({
    templates: listTemplates().map(toDescriptor),
  }));

  /** Freie Portvorschläge für den Anlege-Dialog. */
  app.get<{ Params: { game: string } }>('/api/templates/:game/ports', async (request, reply) => {
    const game = gameIdSchema.safeParse(request.params.game);
    if (!game.success) return reply.code(404).send({ error: 'Unbekannte Vorlage' });
    return { ports: instances.suggestPorts(game.data) };
  });

  app.get('/api/instances', async () => {
    const list = await Promise.all(instances.list().map((i) => instances.toDto(i)));
    return { instances: list };
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id', async (request) =>
    instances.toDto(need(request.params.id)),
  );

  app.post('/api/instances', async (request, reply) => {
    const parsed = createInstanceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Ungültige Eingabe',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const { instance, job } = await instances.create(parsed.data);
    return reply.code(201).send({ id: instance.id, job });
  });

  app.delete<{ Params: { id: string }; Querystring: { data?: string } }>(
    '/api/instances/:id',
    async (request) => {
      need(request.params.id);
      // Weltdaten werden nur auf ausdrückliche Anforderung mitgelöscht.
      await instances.remove(request.params.id, request.query.data === 'true');
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string } }>('/api/instances/:id/settings', async (request, reply) => {
    need(request.params.id);
    const parsed = updateSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    await instances.updateSettings(request.params.id, parsed.data.settings, parsed.data.restart);
    return { ok: true };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post<{ Params: { id: string } }>(`/api/instances/:id/${action}`, async (request) => {
      need(request.params.id);
      await instances[action](request.params.id);
      return { ok: true };
    });
  }

  app.post<{ Params: { id: string } }>('/api/instances/:id/update', async (request) => {
    need(request.params.id);
    return { job: instances.update(request.params.id) };
  });

  // --- Konsole --------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/instances/:id/logs', async (request) => {
    need(request.params.id);
    return { lines: logs.buffer(request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/command', async (request, reply) => {
    const instance = need(request.params.id);
    const parsed = commandRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Kein Befehl übergeben' });

    const template = getTemplate(instance.game);
    if (template.capabilities.console !== 'rcon') {
      return reply.code(400).send({ error: template.notes[0] ?? 'Konsole ist nur lesend' });
    }

    // Der abgesetzte Befehl erscheint im Log — mit Benutzer, für die Nachvollziehbarkeit.
    const user = request.session?.username ?? 'unbekannt';
    logs.append(instance.id, { time: clockHms(), level: 'CMD', text: `> ${parsed.data.command}` });
    app.log.info({ instance: instance.id, user, command: parsed.data.command }, 'Konsolenbefehl');

    try {
      const response = await getAdapter(instance.game).sendCommand(
        instances.adapterContext(instance),
        parsed.data.command,
      );
      if (response.trim()) {
        logs.append(instance.id, { time: clockHms(), level: 'INFO', text: response.trim() });
      }
      return { response };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logs.append(instance.id, { time: clockHms(), level: 'ERROR', text: message });
      return reply.code(err instanceof UnsupportedError ? 400 : 502).send({ error: message });
    }
  });

  // --- Spieler --------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/instances/:id/players', async (request) => {
    const instance = need(request.params.id);
    return {
      players: await getAdapter(instance.game).listPlayers(instances.adapterContext(instance)),
      bans: store.listBans(instance.id),
    };
  });

  app.post<{ Params: { id: string; name: string } }>(
    '/api/instances/:id/players/:name/kick',
    async (request, reply) => {
      const instance = need(request.params.id);
      try {
        await getAdapter(instance.game).kick(instances.adapterContext(instance), request.params.name);
        store.addEvent(instance.id, `${request.params.name} wurde entfernt`);
        return { ok: true };
      } catch (err) {
        return unsupported(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; name: string } }>(
    '/api/instances/:id/players/:name/ban',
    async (request, reply) => {
      const instance = need(request.params.id);
      const parsed = banRequestSchema.safeParse(request.body ?? {});
      const reason = parsed.success ? parsed.data.reason : 'manuell gesperrt · dauerhaft';
      try {
        await getAdapter(instance.game).ban(
          instances.adapterContext(instance),
          request.params.name,
          reason,
        );
        store.addBan(instance.id, request.params.name, reason);
        store.addEvent(instance.id, `${request.params.name} wurde gesperrt`);
        return { ok: true };
      } catch (err) {
        return unsupported(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; name: string } }>(
    '/api/instances/:id/bans/:name',
    async (request, reply) => {
      const instance = need(request.params.id);
      try {
        await getAdapter(instance.game).unban(instances.adapterContext(instance), request.params.name);
      } catch (err) {
        if (!(err instanceof UnsupportedError)) return unsupported(reply, err);
        // Ohne Serverunterstützung wird die Sperre nur im Panel geführt.
      }
      store.removeBan(instance.id, request.params.name);
      store.addEvent(instance.id, `Sperre für ${request.params.name} aufgehoben`);
      return { ok: true };
    },
  );

  // --- Backups --------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/instances/:id/backups', async (request) => {
    need(request.params.id);
    return { backups: store.listBackups(request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/backups', async (request) => {
    need(request.params.id);
    return { job: instances.backup(request.params.id, 'manuell') };
  });

  app.post<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/restore',
    async (request, reply) => {
      need(request.params.id);
      if (!store.getBackup(request.params.id, request.params.backupId)) {
        return reply.code(404).send({ error: 'Backup nicht gefunden' });
      }
      return { job: instances.restore(request.params.id, request.params.backupId) };
    },
  );

  /**
   * Ein heruntergeladenes Backup wieder hochladen. Es erscheint als Snapshot
   * und wird erst über „Restore“ eingespielt — der Upload selbst ändert an der
   * Instanz nichts und geht deshalb auch, während sie läuft.
   */
  app.post<{ Params: { id: string } }>(
    '/api/instances/:id/backups/upload',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const instance = need(request.params.id);
      // Dieselbe Grenze wie für Welten: ein Backup ist im Kern eine Welt.
      const upload = await request.file({ limits: { fileSize: config.worldUploadMaxBytes, files: 1 } });
      if (!upload) return reply.code(400).send({ error: 'Keine Datei übertragen' });
      try {
        const backup = await backups.importUpload(
          instance,
          upload.filename,
          upload.file,
          () => upload.file.truncated,
          config.worldUploadMaxBytes,
        );
        store.addEvent(instance.id, `Backup ${backup.file} hochgeladen`);
        return { backup };
      } catch (err) {
        if (err instanceof BackupError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  /**
   * Ein Backup herunterladen — etwa um es außerhalb des Hosts aufzubewahren.
   * Wie der Welt-Download eine GET-Route, die der Browser selbst streamt:
   * Archive mit mehreren Gigabyte gehören nicht in den Speicher des Tabs.
   */
  app.get<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/download',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const instance = need(request.params.id);
      const backup = store.getBackup(instance.id, request.params.backupId);
      if (!backup) return reply.code(404).send({ error: 'Backup nicht gefunden' });

      const path = backups.fileFor(instance.id, backup.file);
      const info = path ? await stat(path).catch(() => null) : null;
      if (!path || !info?.isFile()) {
        return reply.code(404).send({ error: 'Die Archivdatei fehlt auf der Platte' });
      }

      reply.header('content-type', 'application/zstd');
      reply.header('content-length', String(info.size));
      reply.header('content-disposition', attachment(backup.file));
      return reply.send(createReadStream(path));
    },
  );

  app.delete<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId',
    async (request) => {
      const instance = need(request.params.id);
      await backups.remove(instance, request.params.backupId);
      return { ok: true };
    },
  );

  // --- Welt -----------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/instances/:id/world', async (request, reply) => {
    const instance = need(request.params.id);
    const info = await world.info(instance);
    if (!info) return reply.code(404).send({ error: 'Diese Vorlage benennt keine Weltdaten' });
    return { world: info };
  });

  /**
   * Der Download läuft über eine GET-Route und nicht über den API-Client:
   * `request()` liest jede Antwort als Text und parst sie als JSON, und ein
   * `response.blob()` legte die ganze Welt in den Speicher des Browsers — bei
   * mehreren Gigabyte stürzt der Tab ab. So streamt der Browser auf die Platte,
   * zeigt seinen eigenen Fortschritt und übersteht einen Reload.
   */
  app.get<{ Params: { id: string } }>(
    '/api/instances/:id/world/download',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const instance = need(request.params.id);
      const target = world.target(instance);
      if (!target) return reply.code(404).send({ error: 'Diese Vorlage benennt keine Weltdaten' });

      const present = await world.existingParts(instance, target);
      if (present.length === 0) {
        return reply
          .code(404)
          .send({ error: 'Es gibt noch keine Weltdaten — die Instanz war nie gestartet' });
      }

      const raw = world.isRaw(target, present.map((t) => t.fileName));
      const name = world.downloadName(instance, target, raw);

      if (raw) {
        const part = present[0]!;
        const info = await stat(part.hostPath);
        reply.header('content-type', 'application/octet-stream');
        reply.header('content-length', String(info.size));
        reply.header('content-disposition', attachment(name));
        return reply.send(createReadStream(part.hostPath));
      }

      const entries = (
        await Promise.all(present.map((t) => collectEntries(t.hostPath, t.fileName)))
      ).flat();
      const sizes = await Promise.all(
        entries.map((e) => stat(e.hostPath).then((i) => i.size).catch(() => 0)),
      );
      const total = sizes.reduce((summe, g) => summe + g, 0);

      reply.header('content-type', 'application/zip');
      reply.header('content-disposition', attachment(name));
      const stream = packZip(entries, needsZip64(total, entries.length));
      // Bricht der Benutzer ab, soll der Server nicht weiter von der Platte
      // lesen — ein abgebrochener 20-GB-Download liefe sonst zu Ende.
      reply.raw.on('close', () => {
        stream.destroy(new Error('Download abgebrochen'));
      });
      return reply.send(stream);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/instances/:id/world',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const instance = need(request.params.id);
      const target = world.target(instance);
      if (!target) return reply.code(404).send({ error: 'Diese Vorlage benennt keine Weltdaten' });

      const upload = await request.file({
        // Das globale Limit von 256 MB gilt für Mods; eine Welt sprengt es.
        limits: { fileSize: config.worldUploadMaxBytes, files: 1 },
      });
      if (!upload) return reply.code(400).send({ error: 'Keine Datei übertragen' });

      let source;
      try {
        source = await world.receive(target, upload.filename, upload.file);
      } catch (err) {
        // Eine falsche Endung ist Benutzereingabe, kein Serverfehler.
        if (err instanceof WorldError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      if (upload.file.truncated) {
        await rm(source.path, { force: true });
        return reply
          .code(400)
          .send({ error: `Die Datei ist größer als ${formatBytes(config.worldUploadMaxBytes)}` });
      }

      /*
       * Die Option kommt als Multipart-Textfeld, also als Zeichenkette.
       * `z.coerce.boolean()` wäre hier eine Falle: `Boolean('false')` ist
       * `true`, und die Sicherung ließe sich nie abwählen.
       */
      const chosen = fieldValue(upload.fields, 'backup');
      const options = worldUploadOptionsSchema.safeParse({ backup: chosen });
      if (!options.success) {
        await rm(source.path, { force: true });
        return reply.code(400).send({ error: 'Ungültige Eingabe' });
      }

      try {
        return { job: await instances.replaceWorld(instance.id, source, options.data.backup) };
      } catch (err) {
        await rm(source.path, { force: true });
        // Eine laufende Instanz ist kein Eingabefehler, sondern ein Konflikt.
        if (err instanceof ValidationError && err.message.includes('gestoppt')) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // --- Konfigurationsdateien ------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { volume?: string; path?: string } }>(
    '/api/instances/:id/files',
    async (request, reply) => {
      const instance = need(request.params.id);
      try {
        return await files.list(instance, request.query.volume ?? '', request.query.path ?? '');
      } catch (err) {
        return fileError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { volume?: string; path?: string } }>(
    '/api/instances/:id/files/content',
    async (request, reply) => {
      const instance = need(request.params.id);
      try {
        return await files.read(instance, request.query.volume ?? '', request.query.path ?? '');
      } catch (err) {
        return fileError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/instances/:id/files/content',
    // Der Inhalt darf bis 1 MiB groß sein; als JSON-Zeichenkette mit
    // maskierten Anführungszeichen und Zeilenenden wird er größer als das
    // globale Limit von 2 MB.
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
      const instance = need(request.params.id);
      const parsed = saveFileRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });

      let saved;
      try {
        saved = await files.write(instance, parsed.data);
      } catch (err) {
        return fileError(reply, err);
      }

      // Wer was geändert hat, gehört ins Ereignisprotokoll — eine von Hand
      // bearbeitete Datei ist die erste Spur, wenn ein Server danach nicht mehr startet.
      const user = request.session?.username ?? 'unbekannt';
      app.log.info({ instance: instance.id, user, file: `${saved.volume}/${saved.path}` }, 'Datei bearbeitet');
      instances.announce(instance.id, `${saved.path} von Hand bearbeitet`);

      if (parsed.data.restart) await instances.restart(instance.id);
      return saved;
    },
  );

  // --- Mods -----------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/instances/:id/mods', async (request) => {
    const instance = need(request.params.id);
    return { mods: await mods.list(instance) };
  });

  app.patch<{ Params: { id: string; file: string }; Body: { enabled?: boolean } }>(
    '/api/instances/:id/mods/:file',
    async (request, reply) => {
      const instance = need(request.params.id);
      if (typeof request.body?.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'Feld `enabled` fehlt' });
      }
      await mods.setEnabled(instance, decodeURIComponent(request.params.file), request.body.enabled);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; file: string } }>(
    '/api/instances/:id/mods/:file',
    async (request) => {
      const instance = need(request.params.id);
      await mods.remove(instance, decodeURIComponent(request.params.file));
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/mods', async (request, reply) => {
    const instance = need(request.params.id);
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: 'Keine Datei übertragen' });
    await mods.add(instance, file.filename, await file.toBuffer());
    return { ok: true };
  });

  // --- Jobs -----------------------------------------------------------------

  app.get('/api/jobs', async () => ({ jobs: jobs.listRecent() }));

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'Job nicht gefunden' });
    return job;
  });
}

/** Fehler des Dateidienstes tragen ihren Statuscode selbst; alles andere geht an den globalen Handler. */
function fileError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof FileError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

function unsupported(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(err instanceof UnsupportedError ? 400 : 502).send({ error: message });
}
