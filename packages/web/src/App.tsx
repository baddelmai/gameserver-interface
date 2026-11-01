import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LOG_BUFFER_LENGTH,
  TOPIC,
  clockHms,
  formatBytes,
  type Backup,
  type HostStatus,
  type Instance,
  type Job,
  type LogLine,
  type Mod,
  type SessionInfo,
  type TemplateDescriptor,
  type WorldInfo,
} from '@gsp/shared';
import { api, ApiError, setCsrfToken } from './api/client.js';
import { LiveConnection } from './api/ws.js';
import { Header } from './components/Header.js';
import { Sidebar } from './components/Sidebar.js';
import { DetailHeader } from './components/DetailHeader.js';
import { TabBar, visibleTabs, type TabId } from './components/Tabs.js';
import { useConfirm, type Question } from './components/Confirm.js';
import { Overview } from './tabs/Overview.js';
import { Console } from './tabs/Console.js';
import { Players } from './tabs/Players.js';
import { Backups } from './tabs/Backups.js';
import { World } from './tabs/World.js';
import { Mods } from './tabs/Mods.js';
import { Config } from './tabs/Config.js';
import { Login } from './views/Login.js';
import { NewInstance } from './views/NewInstance.js';
import { Templates } from './views/Templates.js';

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [firstRun, setErsteinrichtung] = useState(false);
  const [geprueft, setGeprueft] = useState(false);

  // Beim Laden prüfen, ob bereits eine Sitzung besteht.
  useEffect(() => {
    void (async () => {
      try {
        const me = await api.me();
        setCsrfToken(me.csrfToken);
        setSession(me);
      } catch {
        const state = await api.authState().catch(() => ({ needsSetup: false }));
        setErsteinrichtung(state.needsSetup);
      } finally {
        setGeprueft(true);
      }
    })();
  }, []);

  if (!geprueft) return <div className="login" />;
  if (!session) {
    return <Login firstRun={firstRun} onAngemeldet={setSession} />;
  }
  return <Panel session={session} onLogout={() => setSession(null)} />;
}

function Panel({ session, onLogout }: { session: SessionInfo; onLogout: () => void }) {
  const [instanzen, setInstanzen] = useState<Instance[]>([]);
  const [templates, setTemplates] = useState<TemplateDescriptor[]>([]);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [mods, setMods] = useState<Mod[]>([]);
  const [world, setWorld] = useState<WorldInfo | null>(null);
  // Vorgabe des Sicherungsschalters im Austauschdialog.
  const [worldBackup, setWeltSicherung] = useState(true);
  const [dialogOpen, setDialogOffen] = useState(false);
  // Letzter Job je Instanz. Er bleibt nach dem Ende stehen, damit die
  // Aufbauansicht den Übergang „Job fertig → Server fährt hoch“ erkennt.
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  // Instanz, deren Aufbau der Dialog gerade begleitet.
  const [building, setImAufbau] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const live = useRef<LiveConnection | null>(null);

  const instance = useMemo(
    () => instanzen.find((i) => i.id === selected) ?? instanzen[0] ?? null,
    [instanzen, selected],
  );
  const template = useMemo(
    () => (instance ? (templates.find((v) => v.id === instance.game) ?? null) : null),
    [templates, instance],
  );

  const loadInstances = useCallback(async () => {
    const response = await api.instances();
    setInstanzen(response.instances);
    setSelected((alt) => alt ?? response.instances[0]?.id ?? null);
  }, []);

  const loadTemplates = useCallback(async () => {
    const response = await api.templates();
    setTemplates(response.templates);
  }, []);

  // Erstdaten und Live-Verbindung.
  useEffect(() => {
    void loadTemplates();
    void api.host().then(setHost).catch(() => undefined);
    void loadInstances();

    const verbindung = new LiveConnection();
    live.current = verbindung;
    verbindung.connect();
    verbindung.subscribe(TOPIC.metrics);
    verbindung.subscribe(TOPIC.events);
    verbindung.subscribe(TOPIC.jobs);

    const abmelden = verbindung.onMessage((nachricht) => {
      if (nachricht.type === 'metrics') {
        setHost(nachricht.host);
        if (nachricht.instances.length === 0) return;
        // Der Takt liefert nur die veränderlichen Teile — der Rest bleibt stehen.
        setInstanzen((alt) =>
          alt.map((entry) => {
            const neu = nachricht.instances.find((i) => i.id === entry.id);
            return neu ? { ...entry, ...neu } : entry;
          }),
        );
      } else if (nachricht.type === 'log') {
        setLogs((alt) => [...alt, ...nachricht.lines].slice(-LOG_BUFFER_LENGTH));
      } else if (nachricht.type === 'event') {
        setInstanzen((alt) =>
          alt.map((entry) =>
            entry.id === nachricht.instanceId
              ? { ...entry, events: [nachricht.event, ...entry.events].slice(0, 9) }
              : entry,
          ),
        );
      } else if (nachricht.type === 'instances-changed') {
        void loadInstances();
      } else if (nachricht.type === 'job') {
        const job = nachricht.job;
        if (job.instanceId) {
          setJobs((alt) => ({ ...alt, [job.instanceId as string]: job }));
        }
        if (job.status === 'failed') {
          setMessage(`${job.kind}: ${job.error ?? 'fehlgeschlagen'}`);
        }
        // Strukturänderungen wie ein fertig aufgesetzter Container sind der
        // Instanzliste sonst nicht anzusehen.
        if (job.status === 'done' || job.status === 'failed') void loadInstances();
      }
    });

    return () => {
      abmelden();
      verbindung.close();
      live.current = null;
    };
  }, [loadInstances, loadTemplates]);

  // Log-Abo folgt der gewählten Instanz.
  useEffect(() => {
    if (!instance || !live.current) return;
    const topic = TOPIC.logs(instance.id);
    setLogs([]);
    void api.logs(instance.id).then((a) => setLogs(a.lines)).catch(() => setLogs([]));
    live.current.subscribe(topic);
    return () => live.current?.unsubscribe(topic);
  }, [instance?.id]);

  // Reiterabhängige Daten nachladen.
  useEffect(() => {
    if (!instance) return;
    if (tab === 'backups') void api.backups(instance.id).then((a) => setBackups(a.backups)).catch(() => undefined);
    if (tab === 'mods') void api.mods(instance.id).then((a) => setMods(a.mods)).catch(() => undefined);
    if (tab === 'welt') {
      void api.world(instance.id).then((a) => setWorld(a.world)).catch(() => setWorld(null));
    }
  }, [tab, instance?.id]);

  /** Führt eine Aktion aus, zeigt Fehler an und lädt die Instanzen neu. */
  const run = useCallback(
    async (fn: () => Promise<unknown>, danach?: () => Promise<unknown>) => {
      setBusy(true);
      setMessage(null);
      try {
        await fn();
        await danach?.();
        await loadInstances();
      } catch (err) {
        setMessage(err instanceof ApiError ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [loadInstances],
  );

  const { ask, dialog: confirmDialog } = useConfirm();

  const tabs = instance ? visibleTabs(instance.capabilities, template?.world !== undefined) : [];
  // Wechselt die Instanz auf eine Vorlage ohne Mods, muss der Reiter zurück.
  useEffect(() => {
    if (instance && !tabs.some((t) => t.id === tab)) setTab('overview');
  }, [instance?.id]);

  return (
    <div className="page">
      <Header
        host={host}
        user={session.username}
        templatesOpen={templatesOpen}
        onTemplates={() => setTemplatesOpen((open) => !open)}
        onLogout={() => {
          void api.logout().finally(() => {
            setCsrfToken(null);
            onLogout();
          });
        }}
      />

      {host && !host.reachable && (
        <div className="banner banner--error" role="alert">
          Container-Backend nicht erreichbar: {host.error ?? 'unbekannter Fehler'}
        </div>
      )}
      {message && (
        <div className="banner banner--warn" role="alert">
          <span style={{ flex: 1 }}>{message}</span>
          <button type="button" className="button button--small" onClick={() => setMessage(null)}>
            Schließen
          </button>
        </div>
      )}

      {/* Vorlagen liegen über den Instanzen und bekommen deshalb die ganze
          Fläche, statt sich als weiterer Reiter in eine Instanz zu drängen. */}
      {templatesOpen && (
        <Templates
          onClose={() => {
            setTemplatesOpen(false);
            // Eine geänderte Vorlage kann Felder und Fähigkeiten verschoben
            // haben — beides steckt in den Instanzansichten.
            void loadTemplates();
            void loadInstances();
          }}
        />
      )}

      {/* `hidden` allein genügt nicht: das Attribut wird von der eigenen
          `display`-Regel der Klasse überstimmt und die Instanzansicht schiene
          unter der Vorlagenverwaltung durch. */}
      <div className="main" hidden={templatesOpen} style={templatesOpen ? { display: 'none' } : undefined}>
        <Sidebar
          instanzen={instanzen}
          selected={instance?.id ?? null}
          onWaehlen={(id) => {
            setSelected(id);
            setNote('');
          }}
          onAnlegen={() => setDialogOffen(true)}
        />

        <main className="detail">
          {!instance && (
            <section className="panel">
              <p className="empty">
                // noch keine Instanz vorhanden — lege links eine aus einer Vorlage an
              </p>
            </section>
          )}

          {instance && template && (
            <>
              <DetailHeader
                instance={instance}
                job={jobs[instance.id] ?? null}
                busy={busy}
                onStart={() => void run(() => api.start(instance.id))}
                onStop={() =>
                  ask({
                    title: 'Server stoppen?',
                    text: `„${instance.name}“ wird heruntergefahren. Verbundene Spieler fliegen raus, laufende Runden brechen ab. Weltdaten bleiben erhalten.`,
                    button: 'Stoppen',
                    danger: true,
                    onJa: () => void run(() => api.stop(instance.id)),
                  })
                }
                onRestart={() =>
                  ask({
                    title: 'Server neu starten?',
                    text: `„${instance.name}“ fährt herunter und wieder hoch. Verbundene Spieler fliegen raus, laufende Runden brechen ab.`,
                    button: 'Neustart',
                    onJa: () => void run(() => api.restart(instance.id)),
                  })
                }
                onBackup={() =>
                  void run(
                    () => api.createBackup(instance.id),
                    () => api.backups(instance.id).then((a) => setBackups(a.backups)),
                  )
                }
              />

              <TabBar tabs={tabs} aktiv={tab} onSwitch={setTab} />

              {tab === 'overview' && <Overview instance={instance} />}

              {tab === 'console' && (
                <Console
                  instance={instance}
                  template={template?.label ?? 'Diese Vorlage'}
                  lines={logs}
                  onBefehl={async (befehl) => {
                    try {
                      await api.command(instance.id, befehl);
                    } catch (err) {
                      setLogs((alt) => [
                        ...alt,
                        {
                          time: clockHms(),
                          level: 'ERROR',
                          text: err instanceof Error ? err.message : String(err),
                        },
                      ]);
                    }
                  }}
                />
              )}

              {tab === 'players' && (
                <Players
                  instance={instance}
                  template={template?.label ?? 'dieser Vorlage'}
                  onKick={(name) => void run(() => api.kick(instance.id, name))}
                  onBann={(name) => void run(() => api.ban(instance.id, name))}
                  onAufheben={(name) => void run(() => api.unban(instance.id, name))}
                />
              )}

              {tab === 'welt' && (
                <World
                  instance={instance}
                  world={world}
                  busy={busy}
                  downloadUrl={api.worldDownloadUrl(instance.id)}
                  onFile={(file) =>
                    ask({
                      title: 'Weltdaten ersetzen?',
                      text: `Die Welt „${world?.name ?? ''}“ von „${instance.name}“ wird durch ${file.name} (${formatBytes(file.size)}) ersetzt. Der bisherige Stand ist danach nur noch über die Sicherung erreichbar.`,
                      button: 'Ersetzen',
                      danger: true,
                      // Ein Fehlklick vernichtet hier den Spielstand von Monaten.
                      typeWord: 'ersetzen',
                      toggle: {
                        label: 'Vorher sichern',
                        help: 'Legt ein Backup an, aus dem sich die bisherige Welt zurückholen lässt.',
                        value: worldBackup,
                        onChange: setWeltSicherung,
                      },
                      onJa: () =>
                        void run(
                          () => api.uploadWorld(instance.id, file, worldBackup),
                          () => api.world(instance.id).then((a) => setWorld(a.world)),
                        ),
                    })
                  }
                />
              )}

              {tab === 'backups' && (
                <Backups
                  instance={instance}
                  backups={backups}
                  busy={busy}
                  onUpdate={() => void run(() => api.update(instance.id))}
                  onCreate={() =>
                    void run(
                      () => api.createBackup(instance.id),
                      () => api.backups(instance.id).then((a) => setBackups(a.backups)),
                    )
                  }
                  onRestore={(backup) =>
                    ask({
                      title: 'Weltdaten wiederherstellen?',
                      text: `Die aktuelle Welt von „${instance.name}“ wird durch den Stand aus ${backup.file} ersetzt.`,
                      button: 'Wiederherstellen',
                      danger: true,
                      onJa: () => void run(() => api.restoreBackup(instance.id, backup.id)),
                    })
                  }
                  onDelete={(backup) =>
                    ask({
                      title: 'Backup löschen?',
                      text: `${backup.file} wird endgültig entfernt.`,
                      button: 'Löschen',
                      danger: true,
                      onJa: () =>
                        void run(
                          () => api.deleteBackup(instance.id, backup.id),
                          () => api.backups(instance.id).then((a) => setBackups(a.backups)),
                        ),
                    })
                  }
                />
              )}

              {tab === 'mods' && (
                <Mods
                  instance={instance}
                  mods={mods}
                  extensions={template?.modExtensions ?? []}
                  onUmschalten={(mod) =>
                    void run(
                      () => api.setModEnabled(instance.id, mod.file, !mod.enabled),
                      () => api.mods(instance.id).then((a) => setMods(a.mods)),
                    )
                  }
                  onDelete={(mod) =>
                    ask({
                      title: 'Mod entfernen?',
                      text: `${mod.name} wird aus „${instance.name}“ gelöscht. Beim nächsten Neustart fehlt der Mod dem Server.`,
                      button: 'Entfernen',
                      onJa: () =>
                        void run(
                          () => api.deleteMod(instance.id, mod.file),
                          () => api.mods(instance.id).then((a) => setMods(a.mods)),
                        ),
                    })
                  }
                  onHinzufuegen={(file) =>
                    void run(
                      () => api.uploadMod(instance.id, file),
                      () => api.mods(instance.id).then((a) => setMods(a.mods)),
                    )
                  }
                />
              )}

              {tab === 'settings' && (
                <Config
                  instance={instance}
                  template={template}
                  note={note}
                  busy={busy}
                  ask={ask}
                  onRestarted={() => void loadInstances()}
                  onSave={(values, restart) =>
                    void run(async () => {
                      await api.saveSettings(instance.id, values, restart);
                      setNote(
                        restart
                          ? `✓ gespeichert · Neustart um ${clockHms().slice(0, 5)}`
                          : '✓ gespeichert · wird beim nächsten Neustart wirksam',
                      );
                    })
                  }
                />
              )}

              <InstanzLoeschen
                instance={instance}
                ask={ask}
                onDelete={(daten) =>
                  void run(async () => {
                    await api.deleteInstance(instance.id, daten);
                    setSelected(null);
                  })
                }
              />
            </>
          )}
        </main>
      </div>

      {confirmDialog}

      {dialogOpen && (
        <NewInstance
          templates={templates}
          buildInstance={building ? (instanzen.find((i) => i.id === building) ?? null) : null}
          buildJob={building ? (jobs[building] ?? null) : null}
          buildLogs={logs}
          onClose={() => {
            setDialogOffen(false);
            setImAufbau(null);
          }}
          onAngelegt={(id) => {
            // Der Dialog bleibt stehen und zeigt den Aufbau. Die Instanz wird
            // sofort gewählt, damit das Log-Abo greift und die Aufbauansicht
            // mitlaufende Zeilen bekommt.
            setImAufbau(id);
            setSelected(id);
            void loadInstances();
          }}
        />
      )}
    </div>
  );
}

function InstanzLoeschen({
  instance,
  ask,
  onDelete,
}: {
  instance: Instance;
  ask: (f: Question) => void;
  onDelete: (daten: boolean) => void;
}) {
  return (
    <section style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-4)', alignItems: 'center' }}>
      <span className="tile__label" style={{ flex: 1 }}>
        // Instanz entfernen
      </span>
      <button
        type="button"
        className="button button--small"
        onClick={() =>
          ask({
            title: 'Container entfernen?',
            text: `Der Container von „${instance.name}“ wird gelöscht. Die Weltdaten bleiben auf der Platte und stehen beim nächsten Start wieder bereit.`,
            button: 'Entfernen',
            onJa: () => onDelete(false),
          })
        }
      >
        Container entfernen
      </button>
      <button
        type="button"
        className="button button--small button--small-danger"
        onClick={() =>
          ask({
            title: 'Mit Weltdaten löschen?',
            text: `„${instance.name}“ wird mitsamt allen Weltdaten unwiderruflich gelöscht. Backups bleiben erhalten.`,
            button: 'Endgültig löschen',
            danger: true,
            typeWord: 'löschen',
            onJa: () => onDelete(true),
          })
        }
      >
        Mit Weltdaten löschen
      </button>
    </section>
  );
}
