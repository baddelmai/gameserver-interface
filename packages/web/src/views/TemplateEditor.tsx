import { useMemo, useState } from 'react';
import type {
  EnvMapping,
  FieldSpec,
  PortSpec,
  TemplateDefinition,
  ValidationRule,
  VolumeSpec,
  WorldDefinition,
  WorldPart,
} from '@gsp/shared';
import { Section, Liste, Toggle, TextField, SelectField, NumberField } from './editor-parts.js';
import { useConfirm } from '../components/Confirm.js';

/**
 * Der Editor einer Vorlage. Er bildet die Definition Abschnitt für Abschnitt
 * ab; gespeichert wird erst auf Knopfdruck, und die eigentliche Prüfung macht
 * der Server — die Fehler kommen feldbezogen zurück und stehen hier oben.
 */
export function TemplateEditor({
  definition,
  builtin,
  instanzen,
  neu,
  errors,
  busy,
  onChange,
  onSave,
  onDelete,
  onCancel,
}: {
  definition: TemplateDefinition;
  builtin: boolean;
  instanzen: number;
  neu: boolean;
  errors: { field: string; message: string }[];
  busy: boolean;
  onChange: (definition: TemplateDefinition) => void;
  onSave: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof TemplateDefinition>(key: K, value: TemplateDefinition[K]) =>
    onChange({ ...definition, [key]: value });

  const { ask, dialog: confirmDialog } = useConfirm();

  return (
    <div className="templateeditor">
      {confirmDialog}
      {errors.length > 0 && (
        <div className="banner banner--error" role="alert">
          <div>
            {errors.map((f, i) => (
              <div key={i}>
                {f.field ? `${f.field}: ` : ''}
                {f.message}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="templateeditor__head">
        <h2 className="templateeditor__name">{definition.label || 'Neue Vorlage'}</h2>
        <span className="templateeditor__meta">
          {builtin ? 'mitgeliefert' : 'eigene Vorlage'}
          {instanzen > 0 ? ` · ${instanzen} Instanzen` : ''}
        </span>
      </div>

      <Section title="Stammdaten" openInitially>
      <TextField
        label="Kennung"
        value={definition.id}
        gesperrt={!neu}
        help={
          neu
            ? 'Kleinbuchstaben, Ziffern, Bindestriche. Sie steckt später in Container-Labels und lässt sich nicht mehr ändern.'
            : 'Unveränderlich — sie steckt in Container-Labels und Instanzdatensätzen.'
        }
        onChange={(value) => set('id', value)}
      />
      <TextField label="Name" value={definition.label} onChange={(value) => set('label', value)} />
      <TextField
        label="Kurzbeschreibung"
        value={definition.summary}
        singleLine={false}
        help="Erscheint auf der Auswahlkarte im Anlege-Wizard."
        onChange={(value) => set('summary', value)}
      />
      <TextField label="Docker-Image" value={definition.image} onChange={(value) => set('image', value)} />
      <TextField label="Standard-Tag" value={definition.defaultTag} onChange={(value) => set('defaultTag', value)} />
      <NumberField
        label="Speicher (MB)"
        value={definition.defaultMemoryMb}
        onChange={(value) => set('defaultMemoryMb', value)}
      />
      <NumberField label="vCPU" value={definition.defaultCpus} onChange={(value) => set('defaultCpus', value)} />
      <TextField
        label="Hinweise"
        value={definition.notes.join('\n')}
        singleLine={false}
        help="Eine Zeile je Hinweis. Sie stehen im Wizard und über der Konsole."
        onChange={(value) => set('notes', value.split('\n').filter((z) => z.trim() !== ''))}
      />
      </Section>

      <Section
        title="Fähigkeiten"
        hint="Danach richtet sich, welche Bedienelemente die Oberfläche zeigt und welcher Adapter den Server abfragt — nicht nach dem Spielnamen."
      >
      <SelectField
        label="Konsole"
        value={definition.capabilities.console}
        options={[
          { value: 'rcon', label: 'RCON — Befehle möglich' },
          { value: 'readonly', label: 'nur lesend — Log-Stream' },
        ]}
        onChange={(value) => set('capabilities', { ...definition.capabilities, console: value })}
      />
      <SelectField
        label="Spielerliste"
        value={definition.capabilities.players}
        options={[
          { value: 'rcon', label: 'über RCON' },
          { value: 'a2s', label: 'Steam-Abfrage (A2S)' },
          { value: 'log', label: 'nur aus dem Log' },
        ]}
        onChange={(value) => set('capabilities', { ...definition.capabilities, players: value })}
      />
      <SelectField
        label="Mods"
        value={definition.capabilities.mods}
        options={[
          { value: 'none', label: 'keine' },
          { value: 'plugins', label: 'Plugins' },
          { value: 'bepinex', label: 'BepInEx' },
        ]}
        onChange={(value) => set('capabilities', { ...definition.capabilities, mods: value })}
      />
      <Toggle
        label="Kick & Bann"
        value={definition.capabilities.moderation}
        help="Nur einschalten, wenn der Server das serverseitig kann."
        onChange={(value) => set('capabilities', { ...definition.capabilities, moderation: value })}
      />
      {definition.capabilities.mods !== 'none' && (
        <TextField
          label="Mod-Verzeichnis"
          value={definition.modsPath ?? ''}
          help="Container-Pfad, etwa /data/plugins."
          onChange={(value) => set('modsPath', value)}
        />
      )}
      {definition.capabilities.mods !== 'none' && (
        <TextField
          label="Mod-Endungen"
          value={definition.modExtensions.join(', ')}
          help="Komma-getrennt, etwa .jar oder .dll"
          onChange={(value) =>
            set(
              'modExtensions',
              value.split(',').map((e) => e.trim()).filter(Boolean),
            )
          }
        />
      )}
      {definition.capabilities.players === 'a2s' && (
        <TextField
          label="Abfrageport"
          value={definition.adapter.queryPortName ?? ''}
          help="Name des Ports aus dem Abschnitt unten, über den die Steam-Abfrage läuft."
          onChange={(value) => set('adapter', { ...definition.adapter, queryPortName: value })}
        />
      )}
      <TextField
        label="Slotzahl-Feld"
        value={definition.adapter.maxPlayersField ?? ''}
        help="Kennung des Felds mit der maximalen Spielerzahl — für die Anzeige „x / y Spieler“."
        onChange={(value) => set('adapter', { ...definition.adapter, maxPlayersField: value || undefined })}
      />
      </Section>

      <Section title="Ports" count={definition.ports.length}>
      <Liste
        entries={definition.ports}
        emptyText="mindestens ein Port wird gebraucht"
        neu={(): PortSpec => ({
          name: 'game',
          label: 'Spielport',
          container: 27015,
          protocol: 'udp',
          defaultHost: 27015,
          internalOnly: false,
        })}
        onChange={(ports) => set('ports', ports)}
        render={(port, change) => (
          <>
            <TextField label="Name" value={port.name} onChange={(v) => change({ ...port, name: v })} />
            <TextField label="Beschriftung" value={port.label} onChange={(v) => change({ ...port, label: v })} />
            <NumberField label="Port im Container" value={port.container} onChange={(v) => change({ ...port, container: v })} />
            <NumberField label="Vorschlag Host" value={port.defaultHost} onChange={(v) => change({ ...port, defaultHost: v })} />
            <SelectField
              label="Protokoll"
              value={port.protocol}
              options={[
                { value: 'tcp', label: 'tcp' },
                { value: 'udp', label: 'udp' },
              ]}
              onChange={(v) => change({ ...port, protocol: v })}
            />
            <Toggle
              label="Nur intern"
              value={port.internalOnly}
              help="Nicht auf dem Host veröffentlichen — richtig für RCON."
              onChange={(v) => change({ ...port, internalOnly: v })}
            />
          </>
        )}
      />

      </Section>

      <Section title="Volumes" count={definition.volumes.length}>
      <Liste
        entries={definition.volumes}
        emptyText="mindestens ein Volume wird gebraucht"
        neu={(): VolumeSpec => ({ name: 'data', containerPath: '/data', role: 'data' })}
        onChange={(volumes) => set('volumes', volumes)}
        render={(volume, change) => (
          <>
            <TextField label="Name" value={volume.name} onChange={(v) => change({ ...volume, name: v })} />
            <TextField
              label="Pfad im Container"
              value={volume.containerPath}
              onChange={(v) => change({ ...volume, containerPath: v })}
            />
            <SelectField
              label="Rolle"
              value={volume.role}
              options={[
                { value: 'data', label: 'Daten' },
                { value: 'config', label: 'Konfiguration' },
                { value: 'mods', label: 'Mods' },
              ]}
              onChange={(v) => change({ ...volume, role: v })}
            />
          </>
        )}
      />

      </Section>

      <Section
        title="Formularfelder"
        count={definition.fields.length}
        hint="Die Reihenfolge bestimmt, wie der Anlege-Wizard und der Config-Reiter aussehen."
      >
      <Liste
        entries={definition.fields}
        emptyText="noch keine Felder — sie bilden den Anlege-Wizard und den Config-Reiter"
        neu={(): FieldSpec => ({
          id: 'neuesFeld',
          label: 'Neues Feld',
          type: 'text',
          default: '',
          required: false,
          editable: true,
          restartRequired: true,
          secret: false,
        })}
        onChange={(fields) => set('fields', fields)}
        render={(field, change) => (
          <>
            <TextField label="Kennung" value={field.id} onChange={(v) => change({ ...field, id: v })} />
            <TextField label="Beschriftung" value={field.label} onChange={(v) => change({ ...field, label: v })} />
            <SelectField
              label="Typ"
              value={field.type}
              options={[
                { value: 'text', label: 'Text' },
                { value: 'password', label: 'Passwort' },
                { value: 'number', label: 'Zahl' },
                { value: 'select', label: 'Auswahl' },
                { value: 'boolean', label: 'Ja/Nein' },
              ]}
              onChange={(v) =>
                change({ ...field, type: v, default: v === 'boolean' ? false : v === 'number' ? 0 : '' })
              }
            />
            <TextField
              label="Standardwert"
              value={String(field.default ?? '')}
              onChange={(v) =>
                change({
                  ...field,
                  default: field.type === 'boolean' ? v === 'true' : field.type === 'number' ? Number(v) : v,
                })
              }
            />
            {field.type === 'select' && (
              <TextField
                label="Optionen"
                value={(field.options ?? []).map((o) => `${o.value}=${o.label}`).join('\n')}
                singleLine={false}
                help="Eine Zeile je Option, Form wert=Beschriftung"
                onChange={(v) =>
                  change({
                    ...field,
                    options: v
                      .split('\n')
                      .map((z) => z.trim())
                      .filter(Boolean)
                      .map((z) => {
                        const [value, ...rest] = z.split('=');
                        return { value: (value ?? '').trim(), label: (rest.join('=') || value || '').trim() };
                      }),
                  })
                }
              />
            )}
            <TextField label="Hilfetext" value={field.help ?? ''} onChange={(v) => change({ ...field, help: v || undefined })} />
            <Toggle label="Pflichtfeld" value={field.required} onChange={(v) => change({ ...field, required: v })} />
            <Toggle
              label="Später änderbar"
              value={field.editable}
              help="Aus für alles, was nach dem Anlegen feststeht — Weltname, Seed."
              onChange={(v) => change({ ...field, editable: v })}
            />
            <Toggle
              label="Geheim"
              value={field.secret}
              help="Wird in der API maskiert und nicht unverändert zurückgeschickt."
              onChange={(v) => change({ ...field, secret: v })}
            />
          </>
        )}
      />

      </Section>

      <EnvSection definition={definition} onChange={(env) => set('env', env)} />
      <LogSection definition={definition} onChange={onChange} />

      <Section title="Backup" count={definition.backup.paths.length}>
      <TextField
        label="Pfade"
        value={definition.backup.paths.join('\n')}
        singleLine={false}
        help="Eine Zeile je Pfad. Sie müssen innerhalb der Volumes oben liegen."
        onChange={(v) =>
          set('backup', { ...definition.backup, paths: v.split('\n').map((z) => z.trim()).filter(Boolean) })
        }
      />
      {definition.capabilities.console === 'rcon' && (
        <>
          <TextField
            label="Vorbefehle"
            value={definition.backup.preCommands.join('\n')}
            singleLine={false}
            help="Vor dem Sichern abgesetzt, etwa save-off."
            onChange={(v) =>
              set('backup', {
                ...definition.backup,
                preCommands: v.split('\n').map((z) => z.trim()).filter(Boolean),
              })
            }
          />
          <TextField
            label="Nachbefehle"
            value={definition.backup.postCommands.join('\n')}
            singleLine={false}
            help="Laufen auch, wenn das Sichern fehlschlägt."
            onChange={(v) =>
              set('backup', {
                ...definition.backup,
                postCommands: v.split('\n').map((z) => z.trim()).filter(Boolean),
              })
            }
          />
        </>
      )}

      </Section>

      <WorldSection
        definition={definition}
        onChange={(world) => {
          const naechste = { ...definition };
          if (world) naechste.world = world;
          else delete naechste.world;
          onChange(naechste);
        }}
      />

      <ValidationSection definition={definition} onChange={(v) => set('validations', v)} />

      {/* Derselbe Hinweis noch einmal am Fuß: der Editor ist lang, und wer
          unten auf „Speichern“ drückt, sieht ein Banner ganz oben nicht. */}
      {errors.length > 0 && (
        <div className="banner banner--error" role="alert">
          <div>
            {errors.map((f, i) => (
              <div key={i}>
                {f.field ? `${f.field}: ` : ''}
                {f.message}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="config__foot">
        <button type="button" className="button button--primary" disabled={busy} onClick={onSave}>
          {neu ? 'Vorlage anlegen' : 'Speichern'}
        </button>
        <button type="button" className="button button--secondary" disabled={busy} onClick={onCancel}>
          Abbrechen
        </button>
        {!neu && (
          <button
            type="button"
            className="button button--small button--small-danger"
            disabled={busy || instanzen > 0}
            title={instanzen > 0 ? 'Es beruhen noch Instanzen auf dieser Vorlage' : undefined}
            onClick={() =>
              // Wie beim Löschen einer Instanz: nachfragen, bevor etwas
              // Unwiderrufliches passiert. Ohne Tippwort — betroffen ist eine
              // Definition, keine Weltdaten.
              ask({
                title: 'Vorlage löschen?',
                text: `Die Vorlage „${definition.label}“ wird entfernt. Bereits angelegte Instanzen laufen weiter, lassen sich danach aber nicht mehr aus ihr neu aufbauen.`,
                button: 'Löschen',
                danger: true,
                onJa: onDelete,
              })
            }
          >
            Löschen
          </button>
        )}
      </div>

      <p className="hint">
        Änderungen wirken auf neue Instanzen sofort. Bestehende laufen unverändert weiter und werden als
        „Vorlage geändert“ markiert — erst ein Neuaufbau übernimmt den neuen Stand.
      </p>
    </div>
  );
}

// --- Umgebungsvariablen -----------------------------------------------------

function EnvSection({
  definition,
  onChange,
}: {
  definition: TemplateDefinition;
  onChange: (env: EnvMapping[]) => void;
}) {
  return (
    <Section
      title="Umgebungsvariablen"
      count={definition.env.length}
      hint="Hier entsteht die Container-Umgebung. Was hier fehlt, sieht der Server nicht."
    >
      <Liste
        entries={definition.env}
        emptyText="noch keine Abbildung — ohne sie startet der Container ohne Konfiguration"
        neu={(): EnvMapping => ({
          name: 'NEUE_VARIABLE',
          source: { kind: 'const', value: '' },
          trim: false,
          omitWhenEmpty: false,
        })}
        onChange={onChange}
        render={(mapping, change) => (
          <>
            <TextField label="Variable" value={mapping.name} onChange={(v) => change({ ...mapping, name: v })} />
            <SelectField
              label="Quelle"
              value={mapping.source.kind}
              options={[
                { value: 'const', label: 'fester Wert' },
                { value: 'field', label: 'Formularfeld' },
                { value: 'port', label: 'Port' },
                { value: 'rconPassword', label: 'RCON-Passwort' },
                { value: 'timezone', label: 'Zeitzone' },
              ]}
              onChange={(v) =>
                change({
                  ...mapping,
                  source:
                    v === 'const'
                      ? { kind: 'const', value: '' }
                      : v === 'field'
                        ? { kind: 'field', field: definition.fields[0]?.id ?? '' }
                        : v === 'port'
                          ? { kind: 'port', port: definition.ports[0]?.name ?? '' }
                          : v === 'rconPassword'
                            ? { kind: 'rconPassword' }
                            : { kind: 'timezone' },
                })
              }
            />
            {mapping.source.kind === 'const' && (
              <TextField
                label="Wert"
                value={mapping.source.value}
                onChange={(v) => change({ ...mapping, source: { kind: 'const', value: v } })}
              />
            )}
            {mapping.source.kind === 'field' && (
              <SelectField
                label="Feld"
                value={mapping.source.field}
                options={definition.fields.map((f) => ({ value: f.id, label: `${f.label} (${f.id})` }))}
                onChange={(v) => change({ ...mapping, source: { kind: 'field', field: v } })}
              />
            )}
            {mapping.source.kind === 'port' && (
              <SelectField
                label="Port"
                value={mapping.source.port}
                options={definition.ports.map((p) => ({ value: p.name, label: `${p.label} (${p.name})` }))}
                onChange={(v) => change({ ...mapping, source: { kind: 'port', port: v } })}
              />
            )}
            <TextField
              label="Ersatzwert"
              value={mapping.fallback ?? ''}
              help="Gilt, wenn die Quelle nichts liefert."
              onChange={(v) => change({ ...mapping, fallback: v || undefined })}
            />
            <Toggle
              label="Ja/Nein übersetzen"
              value={mapping.boolean !== undefined}
              help="Nötig bei Ja/Nein-Feldern — Images erwarten TRUE, true oder eigene Werte."
              onChange={(v) =>
                change({ ...mapping, boolean: v ? { whenTrue: 'true', whenFalse: 'false' } : undefined })
              }
            />
            {mapping.boolean && (
              <>
                <TextField
                  label="Wert bei ja"
                  value={mapping.boolean.whenTrue}
                  onChange={(v) =>
                    change({ ...mapping, boolean: { ...mapping.boolean!, whenTrue: v } })
                  }
                />
                <TextField
                  label="Wert bei nein"
                  value={mapping.boolean.whenFalse}
                  onChange={(v) =>
                    change({ ...mapping, boolean: { ...mapping.boolean!, whenFalse: v } })
                  }
                />
              </>
            )}
            <Toggle
              label="Leer weglassen"
              value={mapping.omitWhenEmpty}
              help="Variable gar nicht setzen statt leer — richtig für optionale Passwörter."
              onChange={(v) => change({ ...mapping, omitWhenEmpty: v })}
            />
            <Toggle
              label="Leerraum entfernen"
              value={mapping.trim}
              onChange={(v) => change({ ...mapping, trim: v })}
            />
          </>
        )}
      />
    </Section>
  );
}

// --- Log --------------------------------------------------------------------

function LogSection({
  definition,
  onChange,
}: {
  definition: TemplateDefinition;
  onChange: (definition: TemplateDefinition) => void;
}) {
  const [probe, setProbe] = useState('');
  const muster = definition.logPatterns;

  const setzeMuster = (teil: Partial<TemplateDefinition['logPatterns']>) =>
    onChange({ ...definition, logPatterns: { ...muster, ...teil } });

  /**
   * Die Probe ist der wichtigste Teil des Editors. Ein falsches Muster fällt
   * sonst erst auf der Zielmaschine auf — dann, wenn keine Spieler erkannt
   * werden oder der Server ewig auf „Startet“ steht.
   */
  const ergebnis = useMemo(() => {
    if (!probe) return null;
    const pruefe = (spec: { source: string; flags: string } | undefined, name: string) => {
      if (!spec?.source) return { name, text: 'kein Muster' };
      try {
        const treffer = new RegExp(spec.source, spec.flags).exec(probe);
        if (!treffer) return { name, text: 'greift nicht' };
        return { name, text: treffer[1] !== undefined ? `Gruppe 1: „${treffer[1]}“` : 'greift' };
      } catch (err) {
        return { name, text: err instanceof Error ? err.message : 'ungültig' };
      }
    };
    const sauber = (() => {
      if (!muster.clean?.pattern.source) return null;
      try {
        const re = new RegExp(muster.clean.pattern.source, muster.clean.pattern.flags);
        return probe.replace(re, muster.clean.replacement).trimEnd();
      } catch {
        return 'ungültiges Muster';
      }
    })();
    return {
      lines: [pruefe(muster.join, 'Beitritt'), pruefe(muster.leave, 'Abgang'), pruefe(muster.ready, 'Start')],
      sauber,
    };
  }, [probe, muster]);

  return (
    <>
      <Section
        title="Log-Muster"
        hint="Reguläre Ausdrücke ohne Schrägstriche. Bei Beitritt und Abgang muss Gruppe 1 der Spielername sein."
      >
      <TextField
        label="Beitritt"
        value={muster.join.source}
        onChange={(v) => setzeMuster({ join: { ...muster.join, source: v } })}
      />
      <TextField
        label="Abgang"
        value={muster.leave?.source ?? ''}
        help="Leer lassen, wenn das Spiel den Abgang nicht mit Namen protokolliert."
        onChange={(v) => setzeMuster({ leave: v ? { source: v, flags: muster.leave?.flags ?? '' } : undefined })}
      />
      <TextField
        label="Server bereit"
        value={muster.ready.source}
        help="Ab dieser Zeile gilt die Instanz als Online."
        onChange={(v) => setzeMuster({ ready: { ...muster.ready, source: v } })}
      />
      <TextField
        label="Zeilenanfang entfernen"
        value={muster.clean?.pattern.source ?? ''}
        help="Schneidet Zeitstempel und Präfixe ab — die Konsole zeigt die Zeit in eigener Spalte."
        onChange={(v) =>
          setzeMuster({ clean: v ? { pattern: { source: v, flags: '' }, replacement: '' } : undefined })
        }
      />

      <div className="field">
        <label className="field__label">Probe</label>
        <div className="field__input">
          <input
            value={probe}
            placeholder="Eine echte Logzeile des Servers einfügen"
            onChange={(e) => setProbe(e.target.value)}
          />
          {ergebnis && (
            <div className="probe">
              {ergebnis.lines.map((z) => (
                <div className="probe__row" key={z.name}>
                  <span className="probe__name">{z.name}</span>
                  <span className={z.text.startsWith('greift n') || z.text === 'kein Muster' ? 'probe__off' : 'probe__on'}>
                    {z.text}
                  </span>
                </div>
              ))}
              {ergebnis.sauber !== null && (
                <div className="probe__row">
                  <span className="probe__name">Bereinigt</span>
                  <span className="probe__on">{ergebnis.sauber}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      </Section>

      <Section
        title="Beispielzeilen ohne Docker"
        hint="Mit GSP_RUNTIME=fake erzeugt das Panel diese Zeilen. Sie müssen zu den Mustern oben passen — sonst bliebe eine Instanz dort für immer auf „Startet“. Platzhalter: {time}, {name}, {n}."
      >
      <SelectField
        label="Zeitformat"
        value={definition.fakeLog?.timeFormat ?? 'iso'}
        options={[
          { value: 'hms', label: '12:34:56' },
          { value: 'dmy', label: '09/09/2026 12:34:56' },
          { value: 'iso', label: '2026-09-09 12:34:56' },
        ]}
        onChange={(v) =>
          onChange({ ...definition, fakeLog: { ...leerFakeLog(definition), timeFormat: v } })
        }
      />
      {(['join', 'leave', 'ready', 'chatter'] as const).map((art) => (
        <TextField
          key={art}
          label={{ join: 'Beitritt', leave: 'Abgang', ready: 'Start', chatter: 'Beiläufig' }[art]}
          value={definition.fakeLog?.[art] ?? ''}
          onChange={(v) =>
            onChange({ ...definition, fakeLog: { ...leerFakeLog(definition), [art]: v } })
          }
        />
      ))}
      </Section>
    </>
  );
}

function leerFakeLog(definition: TemplateDefinition): NonNullable<TemplateDefinition['fakeLog']> {
  return (
    definition.fakeLog ?? {
      timeFormat: 'iso',
      join: '',
      leave: '',
      ready: '',
      chatter: '',
    }
  );
}

// --- Prüfregeln -------------------------------------------------------------

function ValidationSection({
  definition,
  onChange,
}: {
  definition: TemplateDefinition;
  onChange: (regeln: ValidationRule[]) => void;
}) {
  const feldOptionen = definition.fields.map((f) => ({ value: f.id, label: `${f.label} (${f.id})` }));

  return (
    <Section title="Zusätzliche Prüfungen" count={definition.validations.length}>
    <Liste
      entries={definition.validations}
      emptyText="keine — Pflichtfelder und Längen reichen meist"
      neu={(): ValidationRule => ({
        rule: 'required',
        field: definition.fields[0]?.id ?? '',
        message: 'Dieses Feld wird gebraucht',
      })}
      onChange={onChange}
      render={(regel, change) => (
        <>
          <SelectField
            label="Art"
            value={regel.rule}
            options={[
              { value: 'required', label: 'muss ausgefüllt sein' },
              { value: 'minLength', label: 'Mindestlänge' },
              { value: 'pattern', label: 'muss Muster entsprechen' },
              { value: 'notContainedIn', label: 'darf nicht in anderen Feldern vorkommen' },
              { value: 'notEqualTo', label: 'darf anderen Feldern nicht gleichen' },
            ]}
            onChange={(v) => {
              const basis = { field: regel.field, message: regel.message };
              change(
                v === 'required'
                  ? { rule: 'required', ...basis }
                  : v === 'minLength'
                    ? { rule: 'minLength', ...basis, value: 5, onlyWhenSet: true }
                    : v === 'pattern'
                      ? { rule: 'pattern', ...basis, pattern: { source: '^.+$', flags: '' }, onlyWhenSet: true }
                      : v === 'notContainedIn'
                        ? { rule: 'notContainedIn', ...basis, fields: [], onlyWhenSet: true }
                        : { rule: 'notEqualTo', ...basis, fields: [], onlyWhenSet: true },
              );
            }}
          />
          <SelectField
            label="Feld"
            value={regel.field}
            options={feldOptionen}
            onChange={(v) => change({ ...regel, field: v })}
          />
          {regel.rule === 'minLength' && (
            <NumberField label="Mindestens" value={regel.value} onChange={(v) => change({ ...regel, value: v })} />
          )}
          {regel.rule === 'pattern' && (
            <TextField
              label="Muster"
              value={regel.pattern.source}
              onChange={(v) => change({ ...regel, pattern: { ...regel.pattern, source: v } })}
            />
          )}
          {(regel.rule === 'notContainedIn' || regel.rule === 'notEqualTo') && (
            <TextField
              label="Andere Felder"
              value={regel.fields.join(', ')}
              help="Komma-getrennte Feldkennungen."
              onChange={(v) =>
                change({ ...regel, fields: v.split(',').map((f) => f.trim()).filter(Boolean) })
              }
            />
          )}
          {regel.rule !== 'required' && (
            <Toggle
              label="Nur wenn ausgefüllt"
              value={regel.onlyWhenSet}
              onChange={(v) => change({ ...regel, onlyWhenSet: v })}
            />
          )}
          <TextField label="Meldung" value={regel.message} onChange={(v) => change({ ...regel, message: v })} />
        </>
      )}
    />
    </Section>
  );
}

/**
 * Weltdaten — woran der Reiter „Welt" hängt.
 *
 * Der Block ist optional: CS2, TF2 und Garry's Mod haben keine Welt, und ein
 * Welt-Reiter über einer Serverkonfiguration verspräche etwas Falsches. Deshalb
 * steht am Anfang ein Schalter, der ihn anlegt und wieder entfernt.
 */
function WorldSection({
  definition,
  onChange,
}: {
  definition: TemplateDefinition;
  onChange: (world: WorldDefinition | undefined) => void;
}) {
  const world = definition.world;
  const feldOptionen = definition.fields.map((f) => ({ value: f.id, label: `${f.label} (${f.id})` }));

  /** Ein brauchbarer erster Entwurf statt eines leeren Formulars. */
  const anlegen = (): WorldDefinition => ({
    parent: definition.volumes[0]?.containerPath ?? '/data',
    name:
      feldOptionen.length > 0
        ? { kind: 'field', field: feldOptionen[0]!.value }
        : { kind: 'const', value: 'welt' },
    parts: [{ suffix: '', type: 'dir', required: true }],
    markers: [],
    accept: [],
  });

  return (
    <Section title="Weltdaten" count={world ? world.parts.length : 0}>
      <Toggle
        label="Diese Vorlage hat Weltdaten"
        value={world !== undefined}
        help="Schaltet den Reiter „Welt“ frei: Herunterladen und Austausch der Spielwelt."
        onChange={(an) => onChange(an ? anlegen() : undefined)}
      />

      {world && (
        <>
          <TextField
            label="Verzeichnis"
            value={world.parent}
            help="Container-Pfad des Ordners, in dem die Welt liegt. Muss in einem Volume liegen und von den Backup-Pfaden abgedeckt sein — sonst wäre die Sicherung vor dem Austausch wertlos."
            onChange={(v) => onChange({ ...world, parent: v })}
          />

          <SelectField
            label="Weltname"
            value={world.name.kind}
            options={[
              { value: 'field', label: 'aus einem Formularfeld' },
              { value: 'const', label: 'fester Name' },
            ]}
            help="Fast jedes Spiel hat ein Feld dafür. Enshrouded nicht — dort heißt die Welt immer „savegame“."
            onChange={(v) =>
              onChange({
                ...world,
                name:
                  v === 'field'
                    ? { kind: 'field', field: feldOptionen[0]?.value ?? '' }
                    : { kind: 'const', value: 'welt' },
              })
            }
          />
          {world.name.kind === 'field' ? (
            <SelectField
              label="Feld"
              value={world.name.field}
              options={feldOptionen}
              onChange={(v) => onChange({ ...world, name: { kind: 'field', field: v } })}
            />
          ) : (
            <TextField
              label="Name"
              value={world.name.value}
              onChange={(v) => onChange({ ...world, name: { kind: 'const', value: v } })}
            />
          )}

          <p className="hint">
            <strong>Der erste Teil ist die Welt selbst</strong> — nach ihm heißt der Download, und an
            ihm hängt, ob eine rohe Datei oder ein ZIP herauskommt. Weitere Teile sind Geschwister mit
            demselben Stamm: Minecrafts <code>_nether</code>, Valheims <code>.db</code>.
          </p>

          <Liste
            entries={world.parts}
            emptyText="mindestens ein Teil wird gebraucht"
            neu={(): WorldPart => ({ suffix: '', type: 'dir', required: false })}
            onChange={(parts) => onChange({ ...world, parts })}
            render={(teil, change) => (
              <>
                <TextField
                  label="Endung"
                  value={teil.suffix}
                  help="Wird an den Weltnamen gehängt: „_nether“ oder „.fwl“. Leer lassen für den Hauptteil."
                  onChange={(v) => change({ ...teil, suffix: v })}
                />
                <SelectField
                  label="Art"
                  value={teil.type}
                  options={[
                    { value: 'dir', label: 'Verzeichnis' },
                    { value: 'file', label: 'Datei' },
                  ]}
                  onChange={(v) => change({ ...teil, type: v })}
                />
                <Toggle
                  label="Erforderlich"
                  value={teil.required}
                  help="Muss beim Einspielen im Archiv stehen. Valheims Karte (.db) ja — ohne sie wäre die Welt leer; Minecrafts Nether nein."
                  onChange={(v) => change({ ...teil, required: v })}
                />
              </>
            )}
          />

          <TextField
            label="Erkennungsdateien"
            value={world.markers.join('\n')}
            singleLine={false}
            help="Eine Zeile je Datei, etwa level.dat. Daran wird eine Welt in einem fremden Archiv wiedergefunden, das sie tiefer verschachtelt hat."
            onChange={(v) =>
              onChange({ ...world, markers: v.split('\n').map((z) => z.trim()).filter(Boolean) })
            }
          />

          <TextField
            label="Rohe Endungen"
            value={world.accept.join('\n')}
            singleLine={false}
            help="Endungen, unter denen statt eines ZIP eine einzelne Datei hochgeladen werden darf, etwa .wld. Steht hier .zip, wird ein hochgeladenes ZIP nie entpackt, sondern als die Welt selbst genommen — der Fall Factorio."
            onChange={(v) =>
              onChange({ ...world, accept: v.split('\n').map((z) => z.trim()).filter(Boolean) })
            }
          />
        </>
      )}
    </Section>
  );
}
