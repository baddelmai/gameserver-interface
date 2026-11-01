import { mkdirSync, rmSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { UnknownTemplateError } from '@gsp/shared';
import { AuthService, safeEqual } from './auth/sessions.js';
import type { Config } from './config.js';
import { openDb } from './db/index.js';
import { Store } from './db/store.js';
import { DockerRuntime } from './runtime/docker.js';
import { FakeRuntime } from './runtime/fake.js';
import type { Runtime } from './runtime/types.js';
import { BackupService } from './services/backups.js';
import { Hub } from './services/hub.js';
import { InstanceService, ValidationError } from './services/instances.js';
import { JobService } from './services/jobs.js';
import { LogService } from './services/logs.js';
import { MetricsService } from './services/metrics.js';
import { ModService } from './services/mods.js';
import { WorldService } from './services/world.js';
import { FileService } from './services/files.js';
import { Scheduler } from './services/scheduler.js';
import { TemplateService } from './services/templates.js';
import { DraftService } from './services/template-ai.js';
import { Ticker } from './services/ticker.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { instanceRoutes } from './routes/instances.js';
import { templateRoutes } from './routes/templates.js';
import { websocketRoute } from './routes/ws.js';

export interface App {
  server: FastifyInstance;
  config: Config;
  services: Services;
  close(): Promise<void>;
}

export interface Services {
  store: Store;
  auth: AuthService;
  runtime: Runtime;
  hub: Hub;
  logs: LogService;
  metrics: MetricsService;
  backups: BackupService;
  mods: ModService;
  jobs: JobService;
  templates: TemplateService;
  drafts: DraftService;
  instances: InstanceService;
  ticker: Ticker;
  scheduler: Scheduler;
}

/** Routen, die ohne Anmeldung erreichbar sein müssen. */
const PUBLIC_ROUTES = new Set([
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
]);

export async function buildApp(config: Config, runtimeOverride?: Runtime): Promise<App> {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.backupDir, { recursive: true });
  mkdirSync(config.volumeDir, { recursive: true });
  /*
   * Angefangene Uploads eines abgestürzten Laufs. Hier liegt nichts, was einen
   * Neustart überdauern soll — der zugehörige Job ist ohnehin als
   * fehlgeschlagen markiert (`jobs.failStaleJobs()`).
   */
  rmSync(config.tempDir, { recursive: true, force: true });
  mkdirSync(config.tempDir, { recursive: true });

  const db = openDb(config.dbPath);
  const store = new Store(db);
  const auth = new AuthService(db, config.sessionTtlHours);
  auth.purgeExpired();

  const runtime =
    runtimeOverride ??
    (config.runtime === 'fake' ? new FakeRuntime() : new DockerRuntime(config.dockerSocket));

  // Vorlagen zuerst: alle folgenden Dienste schlagen darüber nach, und ohne
  // gefüllte Registry schlägt schon das Laden bestehender Instanzen fehl.
  const templates = new TemplateService(store);
  templates.seedAndLoad();

  const hub = new Hub();
  const jobs = new JobService(db, hub);
  jobs.failStaleJobs();

  const logs = new LogService(runtime, store, hub);
  const metrics = new MetricsService(runtime, store, logs, config.publicHost, config.volumeDir);
  const backups = new BackupService(store, config.volumeDir, config.backupDir);
  const mods = new ModService(config.volumeDir);
  const world = new WorldService(config);
  const files = new FileService(config.volumeDir);
  const instances = new InstanceService(
    config, store, runtime, logs, metrics, backups, jobs, hub, templates, world,
  );
  const ticker = new Ticker(config, runtime, store, instances, metrics, hub);
  const scheduler = new Scheduler(instances);
  const drafts = new DraftService(config.geminiApiKey, config.geminiModel);

  const server = Fastify({
    logger: { level: process.env.GSP_LOG_LEVEL ?? 'info' },
    // Fastify erzeugt sonst pro Anfrage eine ID, die in Tests nur Rauschen ist.
    disableRequestLogging: process.env.GSP_LOG_LEVEL === 'silent',
    // Der Mod-Upload kann groß sein; die Grenze setzt das Multipart-Plugin.
    bodyLimit: 2 * 1024 * 1024,
  });

  await server.register(cookie);
  await server.register(rateLimit, { global: false, max: 200, timeWindow: '1 minute' });
  await server.register(multipart, { limits: { fileSize: 256 * 1024 * 1024, files: 1 } });
  await server.register(websocket);

  /**
   * Anmeldung und CSRF-Schutz. Zustandsändernde Anfragen müssen den Token aus
   * der Sitzung im Header mitschicken — ein fremdes Formular kann das nicht.
   */
  server.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) return;

    const session = auth.getSession(request.cookies[SESSION_COOKIE]);
    if (!session) return reply.code(401).send({ error: 'Nicht angemeldet' });
    request.session = session;

    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, session.csrfToken)) {
      return reply.code(403).send({ error: 'CSRF-Token fehlt oder ist ungültig' });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    // Seit Vorlagen zur Laufzeit entstehen und verschwinden können, ist eine
    // unbekannte Spiel-ID ein normaler Fall — kein interner Fehler.
    if (error instanceof UnknownTemplateError) {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof ValidationError) {
      const code = error.message === 'Instanz nicht gefunden' ? 404 : 400;
      return reply.code(code).send({ error: error.message, fields: error.fields });
    }
    request.log.error({ err: error }, 'Unbehandelter Fehler');
    const detail = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: 'Interner Fehler', detail });
  });

  await server.register(authRoutes, { auth, config });
  await server.register(instanceRoutes, { instances, store, logs, mods, backups, jobs, ticker, templates, world, files, config });
  await server.register(templateRoutes, { templates, instances, jobs, drafts });
  await server.register(websocketRoute, { auth, hub, logs, ticker });

  if (config.webRoot) {
    await server.register(fastifyStatic, { root: config.webRoot, wildcard: false });
    // Einstiegspunkt der Single-Page-Anwendung für alle Nicht-API-Pfade.
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Unbekannte Route' });
      return reply.sendFile('index.html');
    });
  }

  const services: Services = {
    store, auth, runtime, hub, logs, metrics, backups, mods, jobs, templates, drafts, instances, ticker, scheduler,
  };

  return {
    server,
    config,
    services,
    async close() {
      ticker.stop();
      scheduler.stop();
      for (const instance of instances.list()) logs.detach(instance.id);
      await server.close();
      db.close();
    },
  };
}
