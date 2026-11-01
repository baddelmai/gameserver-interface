/**
 * Abstraktion über die Container-Laufzeit. `DockerRuntime` spricht die Docker
 * Engine API, `FakeRuntime` simuliert sie im Speicher — dieselbe Schnittstelle
 * trägt Produktion, Tests und den Entwicklungsmodus ohne Docker.
 *
 * Volumes werden bewusst als Bind-Mounts unterhalb von `config.volumeDir`
 * angelegt: Backups und Mod-Verwaltung arbeiten dadurch direkt auf Host-Pfaden,
 * ohne Dateien durch den Container streamen zu müssen.
 */
export interface ContainerSpec {
  name: string;
  /** Vollständiger Image-Bezeichner inklusive Tag. */
  image: string;
  env: Record<string, string>;
  /**
   * Startargumente. Leer heißt: das Kommando des Images bleibt unangetastet —
   * die meisten Images richten sich vollständig über Env ein.
   */
  cmd?: string[];
  ports: PortBinding[];
  binds: BindMount[];
  memoryMb: number;
  cpus: number;
  labels: Record<string, string>;
}

export interface PortBinding {
  container: number;
  protocol: 'tcp' | 'udp';
  host: number;
  /** Anzahl aufeinanderfolgender Ports ab `container` und `host`; ohne Angabe einer. */
  count?: number;
}

export interface BindMount {
  hostPath: string;
  containerPath: string;
}

export interface ContainerState {
  id: string | null;
  exists: boolean;
  running: boolean;
  /** ISO-Zeitpunkt des letzten Starts, `null` wenn nie gestartet. */
  startedAt: string | null;
  exitCode: number | null;
  /** Fehlermeldung der Laufzeit, z. B. abgebrochener Start. */
  error: string | null;
}

export interface StatsSample {
  at: number;
  /** CPU-Nutzung in Prozent eines einzelnen Kerns × Anzahl Kerne. */
  cpuPctOfHost: number;
  memBytes: number;
  memLimitBytes: number;
  /** Kumulierte Zähler — die Rate berechnet der Metrik-Dienst. */
  netRxBytes: number;
  netTxBytes: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PullProgress {
  /** 0–100, `null` solange die Gesamtgröße unbekannt ist. */
  percent: number | null;
  message: string;
  /**
   * Bereits geladene und erwartete Bytes über alle Layer. `null`, solange
   * Docker noch keine Größen gemeldet hat. Roh, nicht formatiert — die
   * Darstellung entsteht im Frontend.
   */
  currentBytes: number | null;
  totalBytes: number | null;
}

export interface RuntimeHealth {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface LogOptions {
  /** Anzahl der zuletzt geschriebenen Zeilen beim Verbinden. */
  tail?: number;
  /** Stream offen halten und neue Zeilen liefern. */
  follow?: boolean;
  signal?: AbortSignal;
}

export interface Runtime {
  readonly kind: 'docker' | 'fake';
  health(): Promise<RuntimeHealth>;
  pull(image: string, onProgress?: (p: PullProgress) => void): Promise<void>;
  create(spec: ContainerSpec): Promise<string>;
  remove(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutSec?: number): Promise<void>;
  restart(name: string, timeoutSec?: number): Promise<void>;
  inspect(name: string): Promise<ContainerState>;
  stats(name: string): Promise<StatsSample | null>;
  logs(name: string, options: LogOptions): AsyncIterable<string>;
  exec(name: string, cmd: string[]): Promise<ExecResult>;
  /** Gibt alle vom Panel verwalteten Container zurück. */
  list(): Promise<{ name: string; state: ContainerState }[]>;
}

/** Label, an dem das Panel seine eigenen Container erkennt. */
export const MANAGED_LABEL = 'de.gameserver-panel.managed';
export const INSTANCE_LABEL = 'de.gameserver-panel.instance';
