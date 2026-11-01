/**
 * Durchlauf durch den Dateieditor im Config-Reiter gegen `GSP_RUNTIME=fake`.
 *
 * Prüft, was nur die laufende Oberfläche zeigt: Umschalter Formular/Dateien,
 * Vorauswahl der Konfigurationsdateien, Speichern mit Strg+S, Erhalt der
 * Zeilenenden auf der Platte, die JSON-Prüfung mit „Trotzdem speichern“, die
 * Rückfrage vor dem Verwerfen und die Konfliktmeldung, wenn der Server die
 * Datei inzwischen selbst geschrieben hat.
 *
 *   URL=http://127.0.0.1:8793 DATA=<GSP_DATA_DIR> OUT=<Screenshot-Ordner> node pw-config-dateien.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.URL ?? 'http://127.0.0.1:8793';
const OUT = process.env.OUT ?? '.';
const DATA = process.env.DATA;
if (!DATA) throw new Error('DATA muss auf GSP_DATA_DIR zeigen');

const schuss = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
const log = (...a) => console.log('·', ...a);
let fehler = 0;
const pruefe = (text, bedingung) => {
  if (!bedingung) fehler += 1;
  console.log(`  ${bedingung ? 'ja ' : 'NEIN'}  ${text}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('SEITENFEHLER:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('KONSOLE:', m.text());
});

// Ersteinrichtung über die API — das Cookie landet im Browserkontext.
await page.request.post(`${URL}/api/auth/setup`, {
  data: { username: 'admin', password: 'geheim-genug-1234' },
});
await page.goto(URL);
await page.waitForSelector('.page', { timeout: 15000 });
log('angemeldet');

// --- Minecraft-Instanz über den Wizard ---
await page.click('.button--dashed');
await page.waitForSelector('.dialog');
await page.click('.templatecard');
await page.fill('#instanzname', 'Nordheim');
await page.click('.dialog__foot .button--primary');
await page.waitForTimeout(6000);
await page.click('.dialog__head .button--small');
await page.waitForTimeout(800);

const { instances } = await (await page.request.get(`${URL}/api/instances`)).json();
const id = instances[0].id;
const volume = join(DATA, 'instances', id, 'data');
log('Instanz', id);

// So, wie ein Server sie hinterlässt: CRLF, daneben Binäres und ein Plugin.
writeFileSync(join(volume, 'server.properties'), 'motd=Hallo\r\nmax-players=20\r\npvp=true\r\n');
writeFileSync(join(volume, 'ops.json'), '[\n  {"name": "Henner", "level": 4}\n]\n');
writeFileSync(join(volume, 'paper.jar'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));

await page.locator('.tab__button', { hasText: 'Config' }).click();
await page.waitForSelector('.config');
await page.locator('.chip', { hasText: 'Dateien' }).click();
await page.waitForSelector('.files__entry');
await schuss(page, 'dateien-1-liste');

const namen = (await page.locator('.files__entry .row__file').allInnerTexts()).map((t) => t.trim());
log('Liste:', namen.join(', '));
pruefe('server.properties und ops.json stehen in der Liste', namen.includes('server.properties') && namen.includes('ops.json'));
pruefe('paper.jar ist vorab ausgeblendet', !namen.includes('paper.jar'));
await page.locator('.button--small', { hasText: 'weitere Datei' }).click();
const alle = (await page.locator('.files__entry .row__file').allInnerTexts()).map((t) => t.trim());
pruefe('„weitere Dateien zeigen“ blendet paper.jar ein', alle.includes('paper.jar'));
await page.locator('.button--small', { hasText: 'Nur Konfigurationsdateien' }).click();

// --- Bearbeiten und mit Strg+S speichern ---
await page.locator('.files__entry', { hasText: 'server.properties' }).click();
await page.waitForSelector('.editor__text');
const editor = page.locator('.editor__text');
pruefe('Editor zeigt den Inhalt ohne \\r', (await editor.inputValue()) === 'motd=Hallo\nmax-players=20\npvp=true\n');
await editor.fill('motd=Servus aus dem Editor\nmax-players=20\npvp=false\n');
pruefe('Kopf meldet „ungespeichert“', (await page.locator('.files__state').innerText()).includes('ungespeichert'));
pruefe('Pfad steht in echter Schreibweise', (await page.locator('.files__path').innerText()) === '/data/server.properties');
await schuss(page, 'dateien-2-bearbeitet');
await editor.press('Control+s');
await page.waitForSelector('.config__note');
const platte = readFileSync(join(volume, 'server.properties'), 'utf8');
pruefe('Inhalt liegt auf der Platte', platte.includes('Servus aus dem Editor'));
pruefe('Zeilenenden bleiben CRLF', platte === 'motd=Servus aus dem Editor\r\nmax-players=20\r\npvp=false\r\n');

// --- Rückfrage vor dem Verwerfen ---
await editor.fill('motd=noch nicht gespeichert\n');
await page.locator('.files__entry', { hasText: 'ops.json' }).click();
pruefe('Wechsel mit ungespeicherten Änderungen fragt nach', await page.locator('.dialog').isVisible());
await schuss(page, 'dateien-3-rueckfrage');
await page.locator('.dialog .button--danger').click();
await page.waitForTimeout(400);
pruefe('nach dem Verwerfen ist ops.json offen', (await editor.inputValue()).includes('Henner'));

// --- Kaputtes JSON ---
await editor.fill('[\n  {"name": "Henner", "level": 4},\n]\n');
await page.locator('.config__foot .button', { hasText: 'speichern' }).last().click();
await page.waitForSelector('.files__error');
pruefe('JSON-Fehler wird gemeldet', (await page.locator('.files__error').innerText()).includes('JSON'));
pruefe('ops.json auf der Platte unverändert', readFileSync(join(volume, 'ops.json'), 'utf8').includes('"level": 4}\n]'));
await schuss(page, 'dateien-4-json');
await editor.fill('[\n  {"name": "Henner", "level": 3}\n]\n');
await page.locator('.config__foot .button', { hasText: 'speichern' }).last().click();
await page.waitForSelector('.config__note');
pruefe('korrigiertes JSON wird gespeichert', readFileSync(join(volume, 'ops.json'), 'utf8').includes('"level": 3'));

// --- Konflikt: der Server schreibt dazwischen ---
writeFileSync(join(volume, 'ops.json'), '[]\n');
await editor.fill('[\n  {"name": "Henner", "level": 2}\n]\n');
await page.locator('.config__foot .button', { hasText: 'speichern' }).last().click();
await page.waitForSelector('.files__error');
pruefe('Konflikt wird gemeldet', (await page.locator('.files__error').innerText()).includes('inzwischen'));
pruefe('Serverstand bleibt erhalten', readFileSync(join(volume, 'ops.json'), 'utf8') === '[]\n');
await schuss(page, 'dateien-5-konflikt');
await page.locator('.files__error .button', { hasText: 'Neu laden' }).click();
await page.waitForTimeout(400);
pruefe('„Neu laden“ zeigt den Stand des Servers', (await editor.inputValue()) === '[]\n');

// --- Zurück zum Formular ---
await page.locator('.chip', { hasText: 'Formular' }).click();
pruefe('Formular ist wieder sichtbar', await page.locator('.config .field').first().isVisible());

// --- Schmal ---
await page.setViewportSize({ width: 760, height: 1000 });
await page.locator('.chip', { hasText: 'Dateien' }).click();
await schuss(page, 'dateien-6-schmal');
const breite = await page.evaluate(() => document.documentElement.scrollWidth);
pruefe(`kein waagerechtes Scrollen bei 760 px (${breite})`, breite <= 760);

await browser.close();
console.log(fehler === 0 ? 'ALLES GUT' : `${fehler} PRÜFUNG(EN) FEHLGESCHLAGEN`);
process.exit(fehler === 0 ? 0 : 1);
