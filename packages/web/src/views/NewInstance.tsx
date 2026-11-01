import { useEffect, useMemo, useState } from 'react';
import type { CreateInstanceRequest, Instance, Job, LogLine, TemplateDescriptor } from '@gsp/shared';
import { api, ApiError } from '../api/client.js';
import { Field, type Wert } from '../components/Field.js';
import { SectionLabel } from '../components/basics.js';
import { Build, phaseOf } from '../components/Progress.js';

/** Vorbelegung aus den Feld-Defaults der gewählten Vorlage. */
function defaults(template: TemplateDescriptor): Record<string, Wert> {
  const values: Record<string, Wert> = {};
  for (const field of template.fields) {
    if (field.default !== undefined) values[field.id] = field.default;
    else if (field.type === 'boolean') values[field.id] = false;
    else if (field.type === 'number') values[field.id] = field.min ?? 0;
    else values[field.id] = '';
  }
  return values;
}

export function NewInstance({
  templates,
  buildInstance,
  buildJob,
  buildLogs,
  onClose,
  onAngelegt,
}: {
  templates: TemplateDescriptor[];
  /**
   * Gesetzt, sobald die Instanz angelegt ist. Der Dialog schließt dann nicht,
   * sondern begleitet den Aufbau — das Laden des Images und das Hochfahren des
   * Servers sind der Teil, der Minuten dauert.
   */
  buildInstance: Instance | null;
  buildJob: Job | null;
  buildLogs: LogLine[];
  onClose: () => void;
  onAngelegt: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, Wert>>({});
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [memoryMb, setMemoryMb] = useState(4096);
  const [cpus, setCpus] = useState(2);
  const [backupCron, setBackupCron] = useState('0 4 * * *');
  const [keepDays, setKeepDays] = useState(7);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sendet, setSendet] = useState(false);
  const [angelegt, setAngelegt] = useState(false);

  const template = useMemo(
    () => templates.find((v) => v.id === selected) ?? null,
    [templates, selected],
  );

  // Vorlagenwechsel setzt Formular, Ressourcen und freie Ports neu.
  useEffect(() => {
    if (!template) return;
    setValues(defaults(template));
    setMemoryMb(template.defaultMemoryMb);
    setCpus(template.defaultCpus);
    setErrors({});
    setMessage(null);
    void api
      .suggestedPorts(template.id)
      .then((antwort) => setPorts(antwort.ports))
      .catch(() => {
        const vorgabe: Record<string, number> = {};
        for (const port of template.ports) {
          if (!port.internalOnly) vorgabe[port.name] = port.defaultHost;
        }
        setPorts(vorgabe);
      });
  }, [template]);

  const submit = async () => {
    if (!template) return;
    if (!name.trim()) {
      setErrors({ name: 'Ein Name ist erforderlich' });
      return;
    }
    setSendet(true);
    setMessage(null);
    setErrors({});

    const anfrage: CreateInstanceRequest = {
      game: template.id,
      name: name.trim(),
      tag: template.defaultTag,
      ports: Object.entries(ports).map(([portName, host]) => ({ name: portName, host })),
      memoryMb,
      cpus,
      settings: values,
      backupCron,
      backupKeepDays: keepDays,
    };

    try {
      const antwort = await api.createInstance(anfrage);
      setAngelegt(true);
      onAngelegt(antwort.id);
    } catch (err) {
      if (err instanceof ApiError && err.fields.length > 0) {
        const fields: Record<string, string> = {};
        for (const entry of err.fields) fields[entry.field] = entry.message;
        setErrors(fields);
        setMessage(err.message);
      } else {
        setMessage(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen');
      }
    } finally {
      setSendet(false);
    }
  };

  // Ist die Instanz angelegt, begleitet derselbe Dialog den Aufbau, statt sich
  // zu schließen und den Nutzer im Unklaren zu lassen.
  if (angelegt) {
    const phase = phaseOf(buildJob, buildInstance);
    const fertig = phase === 'fertig' || phase === 'fehler';
    return (
      <div
        className="dialog-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Instanz wird aufgesetzt"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="dialog">
          <div className="dialog__head">
            <h2 className="dialog__title">{buildInstance?.name ?? 'Neue Instanz'}</h2>
            <button type="button" className="button button--small" onClick={onClose}>
              Schließen
            </button>
          </div>

          <div className="dialog__body">
            {/* Während des Jobs existiert der Container noch nicht; der Instanzstatus
                lautet dann „Fehler“ und wäre hier irreführend. */}
            <SectionLabel
              text="Instanz wird aufgesetzt"
              right={phase === 'job' ? 'wird aufgebaut' : (buildInstance?.status ?? '')}
            />
            <Build instance={buildInstance} job={buildJob} logs={buildLogs} />
          </div>

          <div className="dialog__foot">
            <span className="hint" style={{ flex: 1 }}>
              {fertig ? '' : 'Der Aufbau läuft weiter, auch wenn du den Dialog schließt.'}
            </span>
            <button
              type="button"
              className={fertig ? 'button button--primary' : 'button button--secondary'}
              onClick={onClose}
            >
              {fertig ? 'Fertig' : 'Im Hintergrund weiter'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Neue Instanz anlegen"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="dialog">
        <div className="dialog__head">
          <h2 className="dialog__title">Neue Instanz</h2>
          <button type="button" className="button button--small" onClick={onClose}>
            Schließen
          </button>
        </div>

        <div className="dialog__body">
          <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <SectionLabel text="Vorlage" />
            <div className="templatechoice">
              {templates.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`templatecard${v.id === selected ? ' templatecard--selected' : ''}`}
                  aria-pressed={v.id === selected}
                  onClick={() => setSelected(v.id)}
                >
                  <span className="templatecard__name">{v.label}</span>
                  <span className="templatecard__text">{v.summary}</span>
                </button>
              ))}
            </div>
          </section>

          {template && (
            <>
              {template.notes.length > 0 && (
                <div className="notes">
                  {template.notes.map((notiz) => (
                    <span className="note" key={notiz}>
                      {notiz}
                    </span>
                  ))}
                </div>
              )}

              <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
                <SectionLabel text="Instanz" />
                <div className="field">
                  <label className="field__label" htmlFor="instanzname">
                    Anzeigename *
                  </label>
                  <div className="field__input">
                    <input
                      id="instanzname"
                      value={name}
                      maxLength={48}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="z. B. Midgard"
                      aria-invalid={errors.name ? true : undefined}
                    />
                    {errors.name && <span className="field__error">{errors.name}</span>}
                  </div>
                </div>

                {template.fields.map((field) => (
                  <Field
                    key={field.id}
                    spec={field}
                    value={values[field.id] ?? ''}
                    errors={errors[field.id]}
                    onChange={(value) => setValues((alt) => ({ ...alt, [field.id]: value }))}
                  />
                ))}
              </section>

              <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
                <SectionLabel text="Ports & Ressourcen" />
                {template.ports
                  .filter((port) => !port.internalOnly)
                  .map((port) => (
                    <div className="field" key={port.name}>
                      <label className="field__label" htmlFor={`port-${port.name}`}>
                        {port.label} ({port.protocol}
                        {port.count && port.count > 1
                          ? ` · ${port.count} Ports bis ${(ports[port.name] ?? port.defaultHost) + port.count - 1}`
                          : ''}
                        )
                      </label>
                      <div className="field__input">
                        <input
                          id={`port-${port.name}`}
                          type="number"
                          min={1}
                          max={65535}
                          value={ports[port.name] ?? port.defaultHost}
                          onChange={(event) =>
                            setPorts((alt) => ({ ...alt, [port.name]: Number(event.target.value) }))
                          }
                          aria-invalid={errors.ports ? true : undefined}
                        />
                      </div>
                    </div>
                  ))}
                {errors.ports && <span className="field__error">{errors.ports}</span>}

                <NumberField id="ram" label="Arbeitsspeicher (MB)" value={memoryMb} min={512} step={512} onChange={setMemoryMb} />
                <NumberField id="cpus" label="CPU-Kerne" value={cpus} min={0.5} step={0.5} onChange={setCpus} />

                <div className="field">
                  <label className="field__label" htmlFor="backupcron">
                    Backup-Zeitplan
                  </label>
                  <div className="field__input">
                    <input
                      id="backupcron"
                      value={backupCron}
                      onChange={(event) => setBackupCron(event.target.value)}
                      placeholder="0 4 * * *"
                    />
                    <span className="field__help">Cron-Ausdruck. Leer lassen für keine automatischen Backups.</span>
                  </div>
                </div>
                <NumberField id="keep" label="Aufbewahrung (Tage)" value={keepDays} min={1} step={1} onChange={setKeepDays} />
              </section>
            </>
          )}
        </div>

        <div className="dialog__foot">
          <span className="field__error">{message}</span>
          <div style={{ display: 'flex', gap: 'var(--s-3)' }}>
            <button type="button" className="button button--secondary" onClick={onClose}>
              Abbrechen
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!template || sendet}
              onClick={() => void submit()}
            >
              {sendet ? 'Wird angelegt…' : 'Anlegen & starten'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="field__input">
        <input
          id={id}
          type="number"
          min={min}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    </div>
  );
}
