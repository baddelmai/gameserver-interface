import { describe, expect, it } from 'vitest';
import { demultiplex, portBindings } from './docker.js';

/** Baut einen Docker-Stream-Rahmen: 1 Byte Typ, 3 Byte Reserve, 4 Byte Länge. */
function rahmen(text: string, typ = 1): Buffer {
  const nutzlast = Buffer.from(text, 'utf8');
  const kopf = Buffer.alloc(8);
  kopf[0] = typ;
  kopf.writeUInt32BE(nutzlast.length, 4);
  return Buffer.concat([kopf, nutzlast]);
}

describe('demultiplex', () => {
  it('entfernt die Stream-Header mehrerer Blöcke', () => {
    const eingabe = Buffer.concat([rahmen('erste Zeile\n'), rahmen('zweite Zeile\n', 2)]);
    const { payload, rest } = demultiplex(eingabe);
    expect(payload).toBe('erste Zeile\nzweite Zeile\n');
    expect(rest.length).toBe(0);
  });

  it('hält einen unvollständigen Block zurück', () => {
    const voll = rahmen('vollständig\n');
    const halb = rahmen('abgeschnitten\n').subarray(0, 10);
    const { payload, rest } = demultiplex(Buffer.concat([voll, halb]));
    expect(payload).toBe('vollständig\n');
    expect(rest.length).toBe(halb.length);
  });

  it('gibt Ausgaben ohne Rahmen unverändert zurück', () => {
    // Container mit TTY liefern rohen Text ohne Header.
    const roh = Buffer.from('rohe Ausgabe ohne Header\n');
    expect(demultiplex(roh).payload).toBe('rohe Ausgabe ohne Header\n');
  });

  it('kommt mit einem leeren Puffer zurecht', () => {
    expect(demultiplex(Buffer.alloc(0))).toEqual({ payload: '', rest: Buffer.alloc(0) });
  });
});

describe('portBindings', () => {
  it('schreibt einen Portbereich als einzelne Bindungen aus', () => {
    const bindings = portBindings([
      { container: 19132, protocol: 'tcp', host: 19200 },
      { container: 19140, protocol: 'udp', host: 19300, count: 3 },
    ]);
    expect(bindings).toEqual([
      { key: '19132/tcp', hostPort: '19200' },
      { key: '19140/udp', hostPort: '19300' },
      { key: '19141/udp', hostPort: '19301' },
      { key: '19142/udp', hostPort: '19302' },
    ]);
  });
});
