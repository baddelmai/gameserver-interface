import { beforeAll, describe, expect, it } from 'vitest';
import { defaultValues, getTemplate, loadBuiltinTemplates, portRange, validateSettings } from './index.js';

/**
 * Bedrock seit NetherNet (BDS 26.50): Verbindungsaufbau über TCP, Spieldaten
 * über einen UDP-Bereich, dessen Adresse und Ports der Server den Clients nennt.
 */

beforeAll(() => loadBuiltinTemplates());

const ctx = (hostPorts: Record<string, number>) => ({ hostPorts, timezone: 'Europe/Berlin' });

describe('Bedrock über NetherNet', () => {
  it('schaltet NetherNet ein und lässt den Server auf dem Container-Port lauschen', () => {
    const template = getTemplate('minecraft-bedrock');
    // Ein anderer Host-Port als 19132 — früher landete er in SERVER_PORT, und
    // der Server lauschte im Container auf einem Port, den Docker nie belieferte.
    const env = template.env(defaultValues(template), ctx({ game: 19200, udp: 19300 }));
    expect(env.TRANSPORT).toBe('nethernet');
    expect(env.SERVER_PORT).toBe('19132');
  });

  it('nennt den Clients Adresse und Host-Bereich der Spieldaten', () => {
    const template = getTemplate('minecraft-bedrock');
    const values = { ...defaultValues(template), publicAddress: '192.168.1.10' };
    const env = template.env(values, ctx({ game: 19132, udp: 19300 }));
    expect(env.SERVER_UDP_PORTS).toBe('192.168.1.10:19300-19319:19140-19159');
  });

  it('übergibt den Platzhalter des Images unverändert', () => {
    const template = getTemplate('minecraft-bedrock');
    const env = template.env(defaultValues(template), ctx({ game: 19132, udp: 19140 }));
    expect(env.SERVER_UDP_PORTS).toBe('<public_ip>:19140-19159:19140-19159');
  });

  it('lässt nur Adressliterale oder den Platzhalter zu, keine Hostnamen', () => {
    const template = getTemplate('minecraft-bedrock');
    const check = (publicAddress: string) =>
      validateSettings(template, { ...defaultValues(template), publicAddress }).map((e) => e.field);
    expect(check('<public_ip>')).not.toContain('publicAddress');
    expect(check('203.0.113.7')).not.toContain('publicAddress');
    expect(check('[2001:db8::1]')).not.toContain('publicAddress');
    expect(check('meinserver.example.org')).toContain('publicAddress');
  });

  it('schreibt einen Bereich nur bei mehr als einem Port aus', () => {
    expect(portRange(19140)).toBe('19140');
    expect(portRange(19140, 1)).toBe('19140');
    expect(portRange(19140, 3)).toBe('19140-19142');
  });
});
