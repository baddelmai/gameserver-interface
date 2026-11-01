import { useRef } from 'react';
import { formatBytes, formatTimestamp, type Backup, type Instance } from '@gsp/shared';
import { Empty, SectionLabel } from '../components/basics.js';

export function Backups({
  instance,
  backups,
  busy,
  downloadUrl,
  onUpdate,
  onCreate,
  onUpload,
  onRestore,
  onDelete,
}: {
  instance: Instance;
  backups: Backup[];
  busy: boolean;
  downloadUrl: (backup: Backup) => string;
  onUpdate: () => void;
  onCreate: () => void;
  onUpload: (file: File) => void;
  onRestore: (backup: Backup) => void;
  onDelete: (backup: Backup) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-8)' }}>
      <section className="panel detailhead">
        <div>
          <div className="tile__label">Version</div>
          <div className="tile__value tile__value--small">{instance.version}</div>
          <div className={`tile__foot${instance.updateAvailable ? ' tile__foot--warn' : ''}`}>
            {instance.updateNote}
          </div>
        </div>
        <div className="detailhead__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={instance.updating || busy}
            onClick={onUpdate}
          >
            {instance.updating ? 'Update läuft…' : 'Update installieren'}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={onCreate}
          >
            Backup erstellen
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => picker.current?.click()}
          >
            Backup hochladen…
          </button>
          <input
            ref={picker}
            type="file"
            accept=".zst,.tar.zst"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Zurücksetzen, damit dieselbe Datei erneut gewählt werden kann.
              event.target.value = '';
              if (file) onUpload(file);
            }}
          />
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <SectionLabel text="Snapshots" right={instance.backupSchedule} />
        <div className="rows">
          {backups.length === 0 && <Empty text="noch keine Snapshots" />}
          {backups.map((backup) => (
            <div className="row" key={backup.id}>
              <span className="row__file" title={backup.file}>
                {backup.file}
              </span>
              <span className="row__time">{formatTimestamp(backup.createdAt)}</span>
              <span className="row__size">{formatBytes(backup.sizeBytes)}</span>
              <span className={`row__kind row__kind--${backup.kind}`}>
                {backup.kind === 'manuell' ? 'Manuell' : 'Auto'}
              </span>
              <button
                type="button"
                className="button button--small"
                disabled={busy}
                onClick={() => onRestore(backup)}
              >
                Restore
              </button>
              {/* Ein Link statt eines Knopfes, damit der Browser die Datei
                  selbst auf die Platte streamt. */}
              <a className="button button--small" href={downloadUrl(backup)} download={backup.file}>
                Download
              </a>
              <button
                type="button"
                className="button button--small button--small-danger"
                disabled={busy}
                onClick={() => onDelete(backup)}
              >
                Löschen
              </button>
            </div>
          ))}
        </div>
        <p className="hint">
          Eine Wiederherstellung stoppt die Instanz, ersetzt die Weltdaten und startet sie danach wieder.
          Heruntergeladene Snapshots sind tar-Archive mit zstd-Kompression; entpacken lassen sie sich
          mit <code>tar --zstd -xf</code> unter Linux und macOS oder unter Windows mit 7-Zip-Zstandard.
          Ein hochgeladenes Backup erscheint als Snapshot und wird erst mit „Restore“ eingespielt. Es muss
          vom Panel stammen und von derselben Vorlage — auch von einer anderen Instanz.
        </p>
      </section>
    </div>
  );
}
