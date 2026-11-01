import { useEffect, useRef, useState } from 'react';
import {
  CONFIG_EXTENSIONS,
  clockHms,
  formatBytes,
  formatTimestamp,
  type FileContent,
  type FileEntry,
  type FileListing,
  type Instance,
  type TemplateDescriptor,
} from '@gsp/shared';
import { api, ApiError } from '../api/client.js';
import type { Question } from '../components/Confirm.js';
import { Empty } from '../components/basics.js';

/** Was beim Speichern schiefging — davon hängt ab, welcher Ausweg angeboten wird. */
type SaveError = { message: string; kind: 'conflict' | 'syntax' | 'other' };

/**
 * Konfigurationsdateien direkt bearbeiten — die Alternative zum Formular.
 *
 * Bewusst ohne Code-Editor-Bibliothek: eine Textarea mit Zeilennummern genügt
 * für Konfigurationsdateien, bleibt barrierearm und kommt ohne weitere
 * Abhängigkeit aus. Die Tabulatortaste bleibt deshalb auch beim Fokuswechsel —
 * wer sie zum Einrücken umbiegt, sperrt Tastaturnutzer im Feld ein.
 */
export function ConfigFiles({
  instance,
  template,
  ask,
  onRestarted,
}: {
  instance: Instance;
  template: TemplateDescriptor;
  ask: (f: Question) => void;
  onRestarted: () => void;
}) {
  const volumes = template.volumes;
  const [volume, setVolume] = useState(volumes[0]?.name ?? '');
  const [dir, setDir] = useState('');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [file, setFile] = useState<FileContent | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [note, setNote] = useState('');

  const dirty = file !== null && text !== file.content;

  // Wechselt die Instanz, beginnt der Editor von vorn.
  useEffect(() => {
    setVolume(volumes[0]?.name ?? '');
    setDir('');
    setFile(null);
    setText('');
    setError(null);
    setNote('');
  }, [instance.id]);

  const loadListing = (volumeName: string, path: string) =>
    api.files(instance.id, volumeName, path).then(setListing);

  useEffect(() => {
    if (!volume) return;
    let current = true;
    setListing(null);
    api
      .files(instance.id, volume, dir)
      .then((result) => current && setListing(result))
      .catch((err: unknown) => {
        if (!current) return;
        setListing({ volume, path: dir, entries: [], truncated: false });
        setError({ message: messageOf(err), kind: 'other' });
      });
    return () => {
      current = false;
    };
  }, [instance.id, volume, dir]);

  /** Fragt nach, bevor ungespeicherte Änderungen verloren gehen. */
  const guard = (action: () => void) => {
    if (!dirty || !file) {
      action();
      return;
    }
    ask({
      title: 'Änderungen verwerfen?',
      text: `${file.path} hat ungespeicherte Änderungen. Sie gehen dabei verloren.`,
      button: 'Verwerfen',
      danger: true,
      onJa: action,
    });
  };

  const open = (volumeName: string, path: string) => {
    setBusy(true);
    setError(null);
    setNote('');
    api
      .readFile(instance.id, volumeName, path)
      .then((result) => {
        setFile(result);
        setText(result.content);
      })
      .catch((err: unknown) => setError({ message: messageOf(err), kind: 'other' }))
      .finally(() => setBusy(false));
  };

  const save = async (options: { force?: boolean; restart?: boolean } = {}) => {
    if (!file || busy || text === file.content) return;
    setBusy(true);
    setError(null);
    setNote('');
    try {
      const saved = await api.saveFile(instance.id, {
        volume: file.volume,
        path: file.path,
        content: text,
        rev: file.rev,
        ...options,
      });
      setFile(saved);
      setText(saved.content);
      setNote(options.restart ? `✓ gespeichert · Neustart um ${clockHms().slice(0, 5)}` : '✓ gespeichert');
      if (options.restart) onRestarted();
      // Größe und Zeitstempel in der Liste stimmen sonst nicht mehr.
      void loadListing(volume, dir).catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError({ message: err.message, kind: 'conflict' });
      } else if (err instanceof ApiError && err.status === 400 && err.message.startsWith('Kein gültiges JSON')) {
        setError({ message: err.message, kind: 'syntax' });
      } else {
        setError({ message: messageOf(err), kind: 'other' });
      }
    } finally {
      setBusy(false);
    }
  };

  const volumeSpec = volumes.find((v) => v.name === volume);
  const entries = listing?.entries ?? [];
  const visible = showAll ? entries : entries.filter((e) => e.type === 'dir' || isConfigFile(e));
  const hidden = entries.length - visible.length;
  const crumbs = dir === '' ? [] : dir.split('/');

  return (
    <div className="files">
      <section className="files__browser">
        {volumes.length > 1 && (
          <div className="chips" role="group" aria-label="Volume">
            {volumes.map((v) => (
              <button
                key={v.name}
                type="button"
                className={`chip${v.name === volume ? ' chip--active' : ''}`}
                aria-pressed={v.name === volume}
                title={v.containerPath}
                onClick={() => {
                  setVolume(v.name);
                  setDir('');
                }}
              >
                {v.containerPath}
              </button>
            ))}
          </div>
        )}

        <nav className="files__crumbs" aria-label="Verzeichnis">
          <button type="button" className="files__crumb" onClick={() => setDir('')}>
            {volumeSpec?.containerPath ?? volume}
          </button>
          {crumbs.map((name, index) => (
            <span key={index}>
              <span className="files__sep">/</span>
              <button
                type="button"
                className="files__crumb"
                onClick={() => setDir(crumbs.slice(0, index + 1).join('/'))}
              >
                {name}
              </button>
            </span>
          ))}
        </nav>

        <div className="rows">
          {!listing && <Empty text="wird geladen" />}
          {listing && entries.length === 0 && (
            <Empty text={dir === '' ? 'noch leer — der Server legt seine Dateien beim ersten Start an' : 'leeres Verzeichnis'} />
          )}
          {visible.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="row files__entry"
              aria-current={file?.volume === volume && file.path === entry.path ? 'true' : undefined}
              onClick={() =>
                entry.type === 'dir' ? setDir(entry.path) : guard(() => open(volume, entry.path))
              }
            >
              <span className="row__file">
                {entry.name}
                {entry.type === 'dir' ? '/' : ''}
              </span>
              {entry.type === 'file' && <span className="row__size">{formatBytes(entry.sizeBytes)}</span>}
            </button>
          ))}
        </div>

        {(hidden > 0 || showAll) && (
          <button type="button" className="button button--small" onClick={() => setShowAll((all) => !all)}>
            {showAll ? 'Nur Konfigurationsdateien' : `${hidden} ${hidden === 1 ? 'weitere Datei' : 'weitere Dateien'} zeigen`}
          </button>
        )}
        {listing?.truncated && (
          <p className="hint">Das Verzeichnis ist groß; gezeigt werden nur die ersten Einträge.</p>
        )}
      </section>

      <section className="files__editor">
        {!file && <Empty text="links eine Datei wählen" />}

        {file && (
          <>
            {/* Kein `SectionLabel`: der setzt in Großbuchstaben, und auf Linux
                sind `Server.properties` und `server.properties` zwei Dateien. */}
            <div className="files__head">
              <span className="files__path">
                {`${volumes.find((v) => v.name === file.volume)?.containerPath ?? file.volume}/${file.path}`}
              </span>
              <span className={dirty ? 'files__state files__state--dirty' : 'files__state'}>
                {dirty ? '● ungespeichert' : `${formatBytes(file.sizeBytes)} · ${formatTimestamp(file.modifiedAt)}`}
              </span>
            </div>

            <Editor
              value={text}
              disabled={busy}
              label={`Inhalt von ${file.path}`}
              onChange={setText}
              onSave={() => void save()}
            />

            {error && (
              <div className="banner banner--warn files__error" role="alert">
                <span style={{ flex: 1 }}>{error.message}</span>
                {error.kind === 'conflict' && (
                  <button type="button" className="button button--small" onClick={() => open(file.volume, file.path)}>
                    Neu laden
                  </button>
                )}
                {error.kind === 'syntax' && (
                  <button
                    type="button"
                    className="button button--small button--small-warn"
                    onClick={() => void save({ force: true })}
                  >
                    Trotzdem speichern
                  </button>
                )}
              </div>
            )}

            <div className="config__foot">
              {instance.running && (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy || !dirty}
                  onClick={() => void save({ restart: true })}
                >
                  Speichern & neu starten
                </button>
              )}
              <button
                type="button"
                className={`button ${instance.running ? 'button--secondary' : 'button--primary'}`}
                disabled={busy || !dirty}
                onClick={() => void save()}
              >
                {instance.running ? 'Nur speichern' : 'Speichern'}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy || !dirty}
                onClick={() => setText(file.content)}
              >
                Verwerfen
              </button>
              {note && <span className="config__note">{note}</span>}
            </div>
          </>
        )}

        {instance.running && (
          <p className="hint hint--warn">
            Die Instanz läuft. Viele Server halten ihre Einstellungen im Speicher und schreiben sie
            beim Beenden zurück — eine Änderung von Hand ginge dabei verloren. Sicherer ist es, die
            Instanz vorher zu stoppen. Hat der Server die Datei inzwischen selbst geschrieben, lehnt
            das Panel das Speichern ab, statt darüberzuschreiben.
          </p>
        )}
        <p className="hint">
          Was das Formular einstellt, schreiben viele Images bei jedem Start aus der Umgebung neu in
          ihre Konfigurationsdateien. Eine Änderung an derselben Stelle hielte nur bis zum nächsten
          Neustart — von Hand gehört hierher, was das Formular nicht kennt. Zeilenenden und
          Kodierung der Datei bleiben beim Speichern erhalten; Strg+S speichert.
        </p>
      </section>
    </div>
  );
}

/** Textarea mit Zeilennummern, die beim Scrollen mitlaufen. */
function Editor({
  value,
  disabled,
  label,
  onChange,
  onSave,
}: {
  value: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const gutter = useRef<HTMLPreElement>(null);
  const lineCount = value.split('\n').length;
  const numbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div className="editor">
      <pre className="editor__gutter" ref={gutter} aria-hidden="true">
        {numbers}
      </pre>
      <textarea
        className="editor__text"
        value={value}
        // `readOnly` statt `disabled`: ein deaktiviertes Feld verlöre beim
        // Speichern mit Strg+S den Fokus und die Cursorposition.
        readOnly={disabled}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onKeyDown={(event) => {
          if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
            // Sonst öffnet der Browser „Seite speichern unter“.
            event.preventDefault();
            onSave();
          }
        }}
      />
    </div>
  );
}

function isConfigFile(entry: FileEntry): boolean {
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 && CONFIG_EXTENSIONS.includes(entry.name.slice(dot).toLowerCase());
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
