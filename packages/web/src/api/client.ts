import type {
  Backup,
  CreateInstanceRequest,
  HostStatus,
  Instance,
  Job,
  LogLine,
  Mod,
  Player,
  SessionInfo,
  TemplateDefinition,
  TemplateDescriptor,
  WorldInfo,
} from '@gsp/shared';

/** Eine Vorlage in der Verwaltungsansicht — mit Nutzungszahl und Herkunft. */
export interface TemplateInfo {
  definition: TemplateDefinition;
  builtin: boolean;
  rev: string;
  instances: number;
}

export interface KiStatus {
  available: boolean;
  reason: string;
  model: string;
}

export interface KiEntwurf {
  definition: TemplateDefinition;
  research: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Wird nach jeder Anmeldung gesetzt und bei mutierenden Anfragen mitgeschickt. */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD' && csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await response.text();

  /*
   * Ein Reverse-Proxy vor dem Panel antwortet bei einem eigenen Größen- oder
   * Zeitlimit mit einer HTML-Fehlerseite statt mit JSON — etwa `client_max_body_size`
   * beim Welt-Upload. Ohne diese Prüfung würde `JSON.parse()` dort mit einem
   * kryptischen „Unexpected token '<'“ abbrechen, statt einer Meldung, die auf
   * die eigentliche Ursache zeigt.
   */
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(
      response.ok
        ? 'Die Antwort war kein JSON — vermutlich hat ein Reverse-Proxy davor die Anfrage abgefangen'
        : `Fehler ${response.status} — die Antwort war kein JSON, vermutlich von einem Reverse-Proxy davor (etwa dessen Größen- oder Zeitlimit)`,
      response.status,
    );
  }

  if (!response.ok) {
    const body = payload as { error?: string; detail?: string; fields?: { field: string; message: string }[] };
    throw new ApiError(
      body.detail ? `${body.error ?? 'Fehler'}: ${body.detail}` : (body.error ?? 'Unbekannter Fehler'),
      response.status,
      body.fields ?? [],
    );
  }
  return payload as T;
}

export const api = {
  authState: () => request<{ needsSetup: boolean }>('/api/auth/state'),
  me: () => request<SessionInfo>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<SessionInfo>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  setup: (username: string, password: string) =>
    request<SessionInfo>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  host: () => request<HostStatus>('/api/host'),
  templates: () => request<{ templates: TemplateDescriptor[] }>('/api/templates'),
  suggestedPorts: (game: string) =>
    request<{ ports: Record<string, number> }>(`/api/templates/${game}/ports`),

  // --- Vorlagenverwaltung ---
  manageTemplates: () => request<{ templates: TemplateInfo[] }>('/api/templates/manage'),
  createTemplate: (definition: TemplateDefinition) =>
    request<{ definition: TemplateDefinition }>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(definition),
    }),
  saveTemplate: (id: string, definition: TemplateDefinition) =>
    request<{ definition: TemplateDefinition }>(`/api/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(definition),
    }),
  deleteTemplate: (id: string) =>
    request<{ ok: true }>(`/api/templates/${id}`, { method: 'DELETE' }),

  kiStatus: () => request<KiStatus>('/api/templates/ki/status'),
  kiEntwurfStarten: (game: string, image: string, notes: string) =>
    request<{ job: Job }>('/api/templates/ki/entwurf', {
      method: 'POST',
      body: JSON.stringify({ game, image, notes }),
    }),
  kiEntwurfHolen: (jobId: string) => request<KiEntwurf>(`/api/templates/ki/entwurf/${jobId}`),

  instances: () => request<{ instances: Instance[] }>('/api/instances'),
  instance: (id: string) => request<Instance>(`/api/instances/${id}`),
  createInstance: (body: CreateInstanceRequest) =>
    request<{ id: string; job: Job }>('/api/instances', { method: 'POST', body: JSON.stringify(body) }),
  deleteInstance: (id: string, deleteData: boolean) =>
    request<{ ok: true }>(`/api/instances/${id}?data=${deleteData}`, { method: 'DELETE' }),
  saveSettings: (id: string, settings: Record<string, string | number | boolean>, restart: boolean) =>
    request<{ ok: true }>(`/api/instances/${id}/settings`, {
      method: 'PATCH',
      body: JSON.stringify({ settings, restart }),
    }),

  start: (id: string) => request<{ ok: true }>(`/api/instances/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<{ ok: true }>(`/api/instances/${id}/stop`, { method: 'POST' }),
  restart: (id: string) => request<{ ok: true }>(`/api/instances/${id}/restart`, { method: 'POST' }),
  update: (id: string) => request<{ job: Job }>(`/api/instances/${id}/update`, { method: 'POST' }),

  logs: (id: string) => request<{ lines: LogLine[] }>(`/api/instances/${id}/logs`),
  command: (id: string, command: string) =>
    request<{ response: string }>(`/api/instances/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),

  players: (id: string) => request<{ players: Player[]; bans: unknown[] }>(`/api/instances/${id}/players`),
  kick: (id: string, name: string) =>
    request<{ ok: true }>(`/api/instances/${id}/players/${encodeURIComponent(name)}/kick`, { method: 'POST' }),
  ban: (id: string, name: string, reason?: string) =>
    request<{ ok: true }>(`/api/instances/${id}/players/${encodeURIComponent(name)}/ban`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? 'manuell gesperrt · dauerhaft' }),
    }),
  unban: (id: string, name: string) =>
    request<{ ok: true }>(`/api/instances/${id}/bans/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  backups: (id: string) => request<{ backups: Backup[] }>(`/api/instances/${id}/backups`),
  createBackup: (id: string) => request<{ job: Job }>(`/api/instances/${id}/backups`, { method: 'POST' }),
  restoreBackup: (id: string, backupId: string) =>
    request<{ job: Job }>(`/api/instances/${id}/backups/${backupId}/restore`, { method: 'POST' }),
  deleteBackup: (id: string, backupId: string) =>
    request<{ ok: true }>(`/api/instances/${id}/backups/${backupId}`, { method: 'DELETE' }),

  world: (id: string) => request<{ world: WorldInfo }>(`/api/instances/${id}/world`),
  /**
   * Nur die URL, kein `fetch`: `request()` liest jede Antwort als Text und
   * parst sie als JSON, und ein `response.blob()` legte die ganze Welt in den
   * Speicher des Browsers — bei mehreren Gigabyte stürzt der Tab ab. Die
   * GET-Route wird deshalb direkt angesprungen; das Sitzungscookie geht bei
   * gleichem Ursprung mit, und CSRF verlangt der Server bei GET nicht.
   */
  worldDownloadUrl: (id: string) => `/api/instances/${id}/world/download`,
  uploadWorld: (id: string, file: File, sicherung: boolean) => {
    const form = new FormData();
    // Das Textfeld muss vor der Datei stehen — der Server liest es aus
    // `file.fields`, und die sind erst gefüllt, wenn sie vorher kamen.
    form.append('backup', sicherung ? 'true' : 'false');
    form.append('file', file);
    return request<{ job: Job }>(`/api/instances/${id}/world`, { method: 'POST', body: form });
  },

  mods: (id: string) => request<{ mods: Mod[] }>(`/api/instances/${id}/mods`),
  setModEnabled: (id: string, file: string, enabled: boolean) =>
    request<{ ok: true }>(`/api/instances/${id}/mods/${encodeURIComponent(file)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  deleteMod: (id: string, file: string) =>
    request<{ ok: true }>(`/api/instances/${id}/mods/${encodeURIComponent(file)}`, { method: 'DELETE' }),
  uploadMod: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: true }>(`/api/instances/${id}/mods`, { method: 'POST', body: form });
  },
};
