import { useEffect, useState } from 'react';
import type { Instance, TemplateDescriptor } from '@gsp/shared';
import { Field, type Wert } from '../components/Field.js';
import type { Question } from '../components/Confirm.js';
import { SectionLabel } from '../components/basics.js';
import { ConfigFiles } from './ConfigFiles.js';

type Mode = 'form' | 'files';

/**
 * Zwei Wege zur selben Konfiguration: das Formular aus der Vorlage und die
 * Dateien selbst. Beide bleiben eingehängt, damit ein Wechsel ungespeicherte
 * Änderungen im Editor nicht verwirft.
 */
export function Config({
  instance,
  template,
  note,
  busy,
  ask,
  onSave,
  onRestarted,
}: {
  instance: Instance;
  template: TemplateDescriptor;
  note: string;
  busy: boolean;
  ask: (f: Question) => void;
  onSave: (values: Record<string, Wert>, restart: boolean) => void;
  onRestarted: () => void;
}) {
  const [mode, setMode] = useState<Mode>('form');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div className="chips" role="group" aria-label="Darstellung">
        {(
          [
            ['form', 'Formular'],
            ['files', 'Dateien'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`chip${mode === id ? ' chip--active' : ''}`}
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div hidden={mode !== 'form'}>
        <ConfigForm instance={instance} template={template} note={note} busy={busy} onSave={onSave} />
      </div>
      <div hidden={mode !== 'files'}>
        <ConfigFiles instance={instance} template={template} ask={ask} onRestarted={onRestarted} />
      </div>
    </div>
  );
}

function ConfigForm({
  instance,
  template,
  note,
  busy,
  onSave,
}: {
  instance: Instance;
  template: TemplateDescriptor;
  note: string;
  busy: boolean;
  onSave: (values: Record<string, Wert>, restart: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, Wert>>(instance.settings);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Wechselt die Instanz, muss das Formular die Werte der neuen übernehmen.
  useEffect(() => {
    setValues(instance.settings);
    setErrors({});
  }, [instance.id, instance.settings]);

  const editierbar = template.fields.filter((field) => field.editable);

  const submit = (restart: boolean) => {
    const open: Record<string, string> = {};
    for (const field of editierbar) {
      const value = values[field.id];
      if (field.required && (value === '' || value === undefined)) {
        open[field.id] = `${field.label} ist erforderlich`;
      }
    }
    setErrors(open);
    if (Object.keys(open).length > 0) return;

    // Unveränderte Geheimnisse werden nicht mitgeschickt — sonst würde die
    // Maskierung „********“ als neues Passwort gespeichert.
    const nutzlast: Record<string, Wert> = {};
    for (const field of editierbar) {
      const value = values[field.id];
      if (value === undefined) continue;
      if (field.secret && value === instance.settings[field.id]) continue;
      nutzlast[field.id] = value;
    }
    onSave(nutzlast, restart);
  };

  return (
    <div className="config">
      <SectionLabel text="Serverkonfiguration" />

      {editierbar.map((field) => (
        <Field
          key={field.id}
          spec={field}
          value={values[field.id] ?? ''}
          errors={errors[field.id]}
          gesperrt={busy}
          onChange={(value) => setValues((alt) => ({ ...alt, [field.id]: value }))}
        />
      ))}

      <div className="config__foot">
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => submit(true)}
        >
          Speichern & neu starten
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={() => submit(false)}
        >
          Nur speichern
        </button>
        {note && <span className="config__note">{note}</span>}
      </div>

      <p className="hint">
        Die Umgebung eines Containers lässt sich nicht nachträglich ändern. „Speichern & neu starten“
        erzeugt den Container neu — die Weltdaten bleiben dabei erhalten. „Nur speichern“ übernimmt die
        Werte erst beim nächsten Neustart.
      </p>
    </div>
  );
}
