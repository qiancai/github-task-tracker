const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'gtt-task-notes-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.GTT_CHROME_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1440, height: 950 }
  });
  const errors = [], requests = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://github.com/**', route => {
    requests.push(route.request().url());
    const number = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    const pullRequest = { number, title: `Example change ${number}`, author: { login: 'demo-author' }, baseBranch: 'main', state: 'OPEN' };
    return route.fulfill({ contentType: 'text/html', body: `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { pullRequestsLayoutRoute: { pullRequest } } })}</script>` });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = worker.url().replace('/src/background.js', '');
  const settings = await context.newPage(); await settings.goto(base + '/settings.html'); await settings.waitForSelector('.label-row');
  const send = operation => settings.evaluate(async operation => {
    const result = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', ...operation });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }, operation);
  const initial = await send({ type: 'get' });
  const a = 'demo-org/project#1', b = 'demo-org/other#2';
  initial.pullRequests = { [a]: ['pending-self'], [b]: ['wait-review'] };
  await send({ type: 'replace', state: initial });
  const tasks = await context.newPage(); await tasks.goto(base + '/tasks.html');
  const other = await context.newPage(); await other.goto(base + '/tasks.html');
  const settled = page => page.locator('#task-results[aria-busy="false"]').waitFor();
  await settled(tasks); await settled(other);
  const row = (page, key = a) => page.locator(`#task-rows tr[data-key="${key}"]`);
  const dialog = tasks.locator('#note-dialog');
  const text = dialog.locator('#note-text');
  const open = async () => { await row(tasks).locator('.task-note').click(); await dialog.waitFor({ state: 'visible' }); };
  const save = async () => { await dialog.getByRole('button', { name: 'Save note', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); await settled(tasks); };
  async function until(predicate, message) {
    for (let i = 0; i < 120; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(message);
  }
  assert.equal(await row(tasks).locator('.task-note').textContent(), 'Add note');
  await open(); await text.fill('Cancel this'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual((await send({ type: 'get' })).notes, {});
  await open(); await text.fill('Escape this'); await tasks.keyboard.press('Escape');
  assert.deepEqual((await send({ type: 'get' })).notes, {});
  const note = 'Check with engineer\n<img src=x onerror=alert(1)>\n下周跟进';
  await open(); await text.fill(note); await save();
  assert.equal((await send({ type: 'get' })).notes[a], note);
  assert.equal((await send({ type: 'get' })).notes[b], undefined);
  await until(async () => await row(other).locator('.task-note').textContent() === note, 'Note did not sync');
  assert.equal(await tasks.locator('.task-notes-cell img,.task-notes-cell script').count(), 0);
  assert.equal(await row(tasks).locator('.task-note').getAttribute('title'), note);
  // Broadcasts preserve the draft; concurrent edits to the same note require review.
  await open(); await text.fill('My unsaved draft');
  await send({ type: 'setLabel', key: b, labelId: 'ready-merge', selected: true });
  await settled(tasks);
  assert.equal(await text.inputValue(), 'My unsaved draft');
  await row(other).locator('.task-note').click();
  await other.locator('#note-text').fill('Edited in another tab');
  await other.locator('#save-note').click(); await other.locator('#note-dialog').waitFor({ state: 'hidden' });
  await until(async () => await dialog.locator('#reload-note').isVisible(), 'Concurrent note conflict missing');
  assert.equal(await dialog.locator('#save-note').isDisabled(), true);
  assert.equal(await text.inputValue(), 'My unsaved draft');
  await dialog.locator('#reload-note').click();
  assert.equal(await text.inputValue(), 'Edited in another tab');
  await text.fill('Ready to follow up');
  await worker.evaluate(() => { globalThis.noteOriginalSet = chrome.storage.local.set; chrome.storage.local.set = () => Promise.reject(new Error('Simulated note save failure')); });
  try {
    await dialog.locator('#save-note').click();
    await until(async () => (await dialog.locator('#note-error').textContent()).includes('Simulated note save failure'), 'Save failure not displayed');
    assert.equal((await send({ type: 'get' })).notes[a], 'Edited in another tab');
    assert.equal(await text.inputValue(), 'Ready to follow up');
  } finally { await worker.evaluate(() => { chrome.storage.local.set = globalThis.noteOriginalSet; delete globalThis.noteOriginalSet; }); }
  await save();
  await tasks.reload(); await settled(tasks);
  assert.equal(await row(tasks).locator('.task-note').textContent(), 'Ready to follow up');
  // Real JSON backup export/import includes notes.
  const downloaded = settings.waitForEvent('download'); await settings.locator('#export').click();
  const download = await downloaded;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(backup.notes[a], 'Ready to follow up');
  // Removing the final label untracks the PR in every tab without deleting its note.
  await row(tasks).locator('button[data-removal]').click();
  await until(async () => await row(tasks).count() === 0 && await row(other).count() === 0, 'Unlabeled PR remained tracked');
  assert.equal((await send({ type: 'get' })).notes[a], 'Ready to follow up');
  await tasks.reload(); await settled(tasks);
  assert.equal(await row(tasks).count(), 0, 'Reload restored an unlabeled PR');
  // Adding a label through the GitHub operation restores the saved note.
  await send({ type: 'setLabel', key: a, labelId: 'pending-engineer', selected: true });
  await until(async () => await row(tasks).count() === 1 && await row(other).count() === 1, 'Relabeled PR did not return');
  assert.equal(await row(tasks).locator('.task-note').textContent(), 'Ready to follow up');
  // A note editor left open in another tab cannot save after the last label is removed.
  await open(); await text.fill('Stale draft');
  await send({ type: 'setLabel', key: a, labelId: 'pending-engineer', selected: false });
  await until(async () => (await dialog.locator('#note-conflict').textContent()).includes('no longer tracked'), 'Stale note editor stayed editable');
  assert.equal(await dialog.locator('#save-note').isDisabled(), true);
  await dialog.locator('#cancel-note').click();
  await send({ type: 'setLabel', key: a, labelId: 'pending-self', selected: true });
  await until(async () => await row(tasks).count() === 1, 'Relabeled PR missing before note clear');
  await open(); await text.fill(''); await save();
  assert.equal(await row(tasks).count(), 1, 'Clearing a note untracked a labeled PR');
  assert.equal((await send({ type: 'get' })).notes[a], undefined);
  await settings.locator('#import').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await settings.locator('#confirm-import').click();
  await until(async () => (await send({ type: 'get' })).notes[a] === 'Ready to follow up', 'Imported backup lost the note');
  await settled(tasks);
  assert.equal(await row(tasks).locator('.task-note').textContent(), 'Ready to follow up');
  await tasks.setViewportSize({ width: 390, height: 844 });
  await open();
  assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().right <= innerWidth), 'Notes dialog overflows mobile');
  await dialog.locator('#cancel-note').click();
  assert.ok(await tasks.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Notes column overflows mobile');
  assert.equal(requests.some(url => /follow|engineer|img|unsaved/.test(url)), false, 'Private note text leaked in a request');
  assert.deepEqual(errors, []);
  console.log('PASS: add/edit/clear notes, cancel/Escape, safe multiline plain text, persistence, cross-tab drafts and conflicts, failure/retry, backup export/import, last-label removal with saved notes, relabeling, and mobile layout.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
