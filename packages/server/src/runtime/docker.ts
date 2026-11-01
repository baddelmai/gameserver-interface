import Docker from 'dockerode';
import { Readable } from 'node:stream';
import {
  INSTANCE_LABEL,
  MANAGED_LABEL,
  type ContainerSpec,
  type ContainerState,
  type ExecResult,
  type LogOptions,
  type PortBinding,
  type PullProgress,
  type Runtime,
  type RuntimeHealth,
  type StatsSample,
} from './types.js';

/**
 * `Buffer` ist in aktuellen Node-Typen generisch über den zugrunde liegenden
 * Speicher; `subarray` und `concat` liefern unterschiedliche Varianten.
 */
type Bytes = Buffer<ArrayBufferLike>;

/** Docker meldet Speicher-Caches mit; die zieht man für eine ehrliche Zahl ab. */
function usedMemory(stats: Docker.ContainerStats): number {
  const raw = stats.memory_stats?.usage ?? 0;
  const cache =
    (stats.memory_stats?.stats as Record<string, number> | undefined)?.inactive_file ??
    (stats.memory_stats?.stats as Record<string, number> | undefined)?.cache ??
    0;
  return Math.max(0, raw - cache);
}

/**
 * CPU-Anteil aus zwei aufeinanderfolgenden Zählerständen. Das Ergebnis ist auf
 * den gesamten Host bezogen: 200 % bedeutet zwei voll ausgelastete Kerne.
 */
function cpuPercent(stats: Docker.ContainerStats): number {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  if (!cpu?.cpu_usage || !pre?.cpu_usage) return 0;
  const cpuDelta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  const cores = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  return (cpuDelta / systemDelta) * cores * 100;
}

function networkTotals(stats: Docker.ContainerStats): { rx: number; tx: number } {
  const networks = stats.networks ?? {};
  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(networks)) {
    rx += iface?.rx_bytes ?? 0;
    tx += iface?.tx_bytes ?? 0;
  }
  return { rx, tx };
}

export class DockerRuntime implements Runtime {
  readonly kind = 'docker' as const;
  private readonly docker: Docker;

  constructor(socketPath: string) {
    this.docker = new Docker({ socketPath });
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const info = await this.docker.version();
      return { ok: true, version: info.Version ?? null, error: null };
    } catch (err) {
      return { ok: false, version: null, error: describe(err) };
    }
  }

  async pull(image: string, onProgress?: (p: PullProgress) => void): Promise<void> {
    const stream = (await this.docker.pull(image)) as Readable;
    await new Promise<void>((resolve, reject) => {
      // Layer-Fortschritte zusammenfassen: Docker meldet je Layer eigene Zähler.
      const layers = new Map<string, { current: number; total: number }>();
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { id?: string; status?: string; progressDetail?: { current?: number; total?: number } }) => {
          if (!onProgress) return;
          if (event.id && event.progressDetail?.total) {
            layers.set(event.id, {
              current: event.progressDetail.current ?? 0,
              total: event.progressDetail.total,
            });
          }
          let current = 0;
          let total = 0;
          for (const layer of layers.values()) {
            current += layer.current;
            total += layer.total;
          }
          onProgress({
            percent: total > 0 ? Math.min(100, (current / total) * 100) : null,
            message: event.status ?? 'lädt',
            currentBytes: total > 0 ? current : null,
            totalBytes: total > 0 ? total : null,
          });
        },
      );
    });
  }

  async create(spec: ContainerSpec): Promise<string> {
    const exposed: Record<string, Record<string, never>> = {};
    const bindings: Record<string, { HostPort: string }[]> = {};
    // Ein Bereich wird zu einzelnen Bindungen: die Engine-API kennt keine
    // Bereiche, nur `docker run -p` übersetzt sie selbst.
    for (const binding of portBindings(spec.ports)) {
      exposed[binding.key] = {};
      bindings[binding.key] = [{ HostPort: binding.hostPort }];
    }

    const container = await this.docker.createContainer({
      name: spec.name,
      // Nur setzen, wenn die Vorlage etwas vorgibt: sonst überschriebe ein
      // leeres Array das Kommando des Images und der Container täte nichts.
      ...(spec.cmd && spec.cmd.length > 0 ? { Cmd: spec.cmd } : {}),
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { ...spec.labels, [MANAGED_LABEL]: 'true' },
      ExposedPorts: exposed,
      HostConfig: {
        PortBindings: bindings,
        Binds: spec.binds.map((b) => `${b.hostPath}:${b.containerPath}`),
        Memory: spec.memoryMb * 1024 * 1024,
        // Ohne Swap-Grenze würde das Speicherlimit über Swap unterlaufen.
        MemorySwap: spec.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(spec.cpus * 1e9),
        RestartPolicy: { Name: 'unless-stopped' },
        // Das Panel steuert den Lebenszyklus; Logs werden begrenzt, damit die
        // Platte nicht durch einen dauerhaft laufenden Server volläuft.
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
      },
      // Hält stdin offen — manche Images erwarten das für ihren Supervisor.
      OpenStdin: true,
      Tty: false,
    });
    return container.id;
  }

  private container(name: string): Docker.Container {
    return this.docker.getContainer(name);
  }

  async remove(name: string): Promise<void> {
    try {
      await this.container(name).remove({ force: true, v: false });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async start(name: string): Promise<void> {
    try {
      await this.container(name).start();
    } catch (err) {
      // 304 = läuft bereits.
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
  }

  async stop(name: string, timeoutSec = 30): Promise<void> {
    try {
      await this.container(name).stop({ t: timeoutSec });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304 && !isNotFound(err)) throw err;
    }
  }

  async restart(name: string, timeoutSec = 30): Promise<void> {
    await this.container(name).restart({ t: timeoutSec });
  }

  async inspect(name: string): Promise<ContainerState> {
    try {
      const info = await this.container(name).inspect();
      return {
        id: info.Id,
        exists: true,
        running: info.State?.Running ?? false,
        startedAt: info.State?.StartedAt && !info.State.StartedAt.startsWith('0001')
          ? info.State.StartedAt
          : null,
        exitCode: info.State?.ExitCode ?? null,
        error: info.State?.Error ? info.State.Error : null,
      };
    } catch (err) {
      if (isNotFound(err)) {
        return { id: null, exists: false, running: false, startedAt: null, exitCode: null, error: null };
      }
      throw err;
    }
  }

  async stats(name: string): Promise<StatsSample | null> {
    try {
      const raw = (await this.container(name).stats({ stream: false })) as unknown as Docker.ContainerStats;
      const net = networkTotals(raw);
      return {
        at: Date.now(),
        cpuPctOfHost: cpuPercent(raw),
        memBytes: usedMemory(raw),
        memLimitBytes: raw.memory_stats?.limit ?? 0,
        netRxBytes: net.rx,
        netTxBytes: net.tx,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *logs(name: string, options: LogOptions): AsyncIterable<string> {
    const stream = (await this.container(name).logs({
      stdout: true,
      stderr: true,
      // Die Typen von dockerode verlangen ein Literal; zur Laufzeit ist beides zulässig.
      follow: (options.follow ?? false) as true,
      tail: options.tail ?? 200,
      timestamps: false,
    })) as unknown as Readable;

    if (options.signal) {
      options.signal.addEventListener('abort', () => stream.destroy(), { once: true });
    }

    let buffer: Bytes = Buffer.alloc(0);
    let text = '';
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk as Bytes]);
      // Ohne TTY rahmt Docker jede Ausgabe in einen 8-Byte-Header.
      const { payload, rest } = demultiplex(buffer);
      buffer = rest;
      text += payload;
      const lines = text.split('\n');
      text = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) yield line;
      }
    }
    if (text.trim().length > 0) yield text;
  }

  async exec(name: string, cmd: string[]): Promise<ExecResult> {
    const exec = await this.container(name).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = (await exec.start({ hijack: true, stdin: false })) as unknown as Readable;
    const chunks: Bytes[] = [];
    for await (const chunk of stream) chunks.push(chunk as Bytes);
    const { payload } = demultiplex(Buffer.concat(chunks));
    const info = await exec.inspect();
    return { exitCode: info.ExitCode ?? 0, stdout: payload, stderr: '' };
  }

  async list(): Promise<{ name: string; state: ContainerState }[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    });
    return containers.map((c) => ({
      name: c.Labels?.[INSTANCE_LABEL] ?? (c.Names?.[0] ?? '').replace(/^\//, ''),
      state: {
        id: c.Id,
        exists: true,
        running: c.State === 'running',
        startedAt: null,
        exitCode: null,
        error: null,
      },
    }));
  }
}

/**
 * Entfernt die Stream-Header, die Docker ohne TTY vor jeden Ausgabeblock setzt
 * (1 Byte Stream-Typ, 3 Byte Reserve, 4 Byte Länge). Ein unvollständiger Block
 * am Ende wird zurückgegeben und beim nächsten Aufruf ergänzt.
 */
/** Schreibt Portbereiche als einzelne Bindungen aus: `19140/udp` → `19140`, `19141/udp` → `19141` … */
export function portBindings(ports: PortBinding[]): { key: string; hostPort: string }[] {
  const out: { key: string; hostPort: string }[] = [];
  for (const port of ports) {
    for (let i = 0; i < (port.count ?? 1); i += 1) {
      out.push({ key: `${port.container + i}/${port.protocol}`, hostPort: String(port.host + i) });
    }
  }
  return out;
}

export function demultiplex(buffer: Bytes): { payload: string; rest: Bytes } {
  let offset = 0;
  const parts: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    // Gültige Stream-Typen sind 0–2; alles andere ist rohe Ausgabe ohne Rahmen.
    if (type === undefined || type > 2) return { payload: buffer.toString('utf8'), rest: Buffer.alloc(0) };
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return { payload: Buffer.concat(parts).toString('utf8'), rest: buffer.subarray(offset) };
}

function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'Docker-Socket nicht gefunden — läuft der Daemon und ist der Socket eingebunden?';
    }
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return 'Kein Zugriff auf den Docker-Socket — Benutzer der docker-Gruppe hinzufügen.';
    }
    return err.message;
  }
  return String(err);
}
