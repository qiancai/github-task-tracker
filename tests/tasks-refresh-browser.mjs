const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'gtt-task-refresh-'));
let context;
let release;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.GTT_CHROME_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1320, height: 800 }
  });
  let gate;
  let fail = false;
  let revision = 1;
  let requests = 0;
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://github.com/**', async route => {
    requests++;
    if (gate) await gate;
    if (fail) return route.fulfill({ status: 503, body: 'Temporarily unavailable' });
    const number = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    const pullRequest = { number, title: `Revision ${revision} example ${number}`, author: { login: `demo-${number % 3}` }, baseBranch: 'main', state: 'OPEN' };
    return route.fulfill({ contentType: 'text/html', body: `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { pullRequestsLayoutRoute: { pullRequest } } })}</script>` });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.testPorts = [];
    chrome.runtime.onConnect.addListener(port => globalThis.testPorts.push(port));
  });
  const base = worker.url().replace('/src/background.js', '');
  const settings = await context.newPage(); await settings.goto(base + '/settings.html'); await settings.waitForSelector('.label-row');
  await settings.evaluate(async () => {
    const { data: state } = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', type: 'get' });
    state.pullRequests = Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`demo-org/project#${i + 1}`, ['wait-review']]));
    await chrome.runtime.sendMessage({ scope: 'github-task-tracker', type: 'replace', state });
  });
  const tasks = await context.newPage(); await tasks.goto(base + '/tasks.html#sort=author&direction=asc');
  const settled = () => tasks.locator('#task-results[aria-busy="false"]').waitFor();
  const titles = () => tasks.locator('.task-title').allTextContents();
  await settled();
  assert.equal(requests, 28, 'Metadata sorting must still cover off-page PRs');
  await tasks.locator('.task-checkbox').first().check();
  const original = await titles();
  await tasks.evaluate(() => {
    globalThis.firstRow = document.querySelector('#task-rows tr');
    globalThis.sawEmpty = false;
    new MutationObserver(() => {
      if (!document.querySelector('#task-rows tr')) globalThis.sawEmpty = true;
    }).observe(document.querySelector('#task-rows'), { childList: true });
  });
  // Worker reconnects deliver the same state and must not rebuild the table or refetch details.
  const portCount = await worker.evaluate(() => globalThis.testPorts.length);
  await worker.evaluate(() => globalThis.testPorts.forEach(port => { try { port.disconnect(); } catch {} }));
  for (let i = 0; i < 100; i++) {
    if (await worker.evaluate(count => globalThis.testPorts.length > count, portCount)) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(await worker.evaluate(count => globalThis.testPorts.length > count, portCount), 'Page did not reconnect');
  await tasks.waitForTimeout(100);
  assert.equal(await tasks.evaluate(() => globalThis.firstRow === document.querySelector('#task-rows tr')), true);
  assert.equal(requests, 28);
  // Returning with expired details starts a background update without hiding cached rows.
  gate = new Promise(resolve => { release = resolve; });
  await tasks.bringToFront();
  await tasks.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 6 * 60 * 1000;
    try { document.dispatchEvent(new Event('visibilitychange')); }
    finally { Date.now = now; }
  });
  assert.equal(await tasks.locator('#task-results').getAttribute('aria-busy'), 'true');
  assert.deepEqual(await titles(), original);
  gate = undefined; release(); await settled();
  assert.equal(await tasks.locator('#refresh-status').isVisible(), false);
  assert.equal(await tasks.locator('#refresh-details').isEnabled(), true);
  // A slow sorted refresh retains complete details and checkbox selection throughout the request.
  gate = new Promise(resolve => { release = resolve; }); revision = 2;
  await tasks.locator('#refresh-details').click();
  assert.equal(await tasks.locator('#task-results').getAttribute('aria-busy'), 'true');
  assert.equal(await tasks.locator('#refresh-details').getAttribute('aria-busy'), 'true');
  assert.equal(await tasks.locator('#refresh-details').isDisabled(), true);
  assert.equal(await tasks.locator('#refresh-status').isVisible(), true);
  assert.match(await tasks.locator('#sort-progress').textContent(), /Refreshing 0 \/ 28 PRs/);
  assert.equal(await tasks.locator('#refresh-progress').getAttribute('max'), '28');
  assert.ok(await tasks.locator('#refresh-status').evaluate(panel => {
    const button = document.querySelector('#refresh-details').getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    return Math.abs(rect.top - button.bottom - 6) < 1 && Math.abs(rect.right - button.right) < 1;
  }), 'Refresh progress must appear below and align with the refresh icon');
  await tasks.setViewportSize({ width: 390, height: 844 });
  await tasks.waitForFunction(() => { const rect = document.querySelector('#refresh-status').getBoundingClientRect(); return rect.left >= 12 && rect.right <= innerWidth - 12; });
  assert.ok(await tasks.locator('#refresh-status').evaluate(panel => {
    const rect = panel.getBoundingClientRect(); return rect.left >= 12 && rect.right <= innerWidth - 12;
  }), 'Refresh progress overflows a narrow viewport');
  await tasks.setViewportSize({ width: 1320, height: 800 });
  assert.deepEqual(await titles(), original);
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 1);
  assert.equal(await tasks.locator('.author-name').first().textContent(), 'demo-0');
  await settings.bringToFront(); await tasks.bringToFront();
  assert.deepEqual(await titles(), original, 'Switching tabs must keep the current list visible');
  gate = undefined; release(); await settled();
  assert.ok((await titles()).every(title => title.startsWith('Revision 2')));
  assert.equal(await tasks.locator('#refresh-details').getAttribute('aria-busy'), 'false');
  assert.equal(await tasks.locator('#refresh-status').isVisible(), false);
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 1);
  assert.equal(await tasks.evaluate(() => globalThis.sawEmpty), false, 'Refreshing briefly cleared the list');
  // Failed background updates keep last known details, show an error, and can be retried.
  fail = true; await tasks.locator('#refresh-details').click(); await settled();
  assert.ok((await titles()).every(title => title.startsWith('Revision 2')));
  assert.match(await tasks.locator('.task-error').first().textContent(), /Showing last loaded details.*503/);
  assert.equal(await tasks.evaluate(() => globalThis.sawEmpty), false);
  assert.equal(await tasks.locator('#refresh-details').isEnabled(), true, 'Failed refresh left the icon stuck busy');
  assert.equal(await tasks.locator('#refresh-status').isVisible(), false);
  fail = false;
  await tasks.locator('.task-retry').first().click(); await settled();
  assert.equal(await tasks.locator('.task-error').first().textContent(), '');
  // Recovered/reloaded tabs render their session cache without requesting all details again.
  const beforeReload = requests;
  await tasks.reload(); await settled();
  assert.equal(requests, beforeReload);
  assert.ok((await titles()).every(title => title.startsWith('Revision 2')));
  assert.equal(await tasks.locator('#sort-field').inputValue(), 'author');
  await tasks.getByRole('button', { name: 'Next', exact: true }).click(); await settled();
  assert.equal(await tasks.locator('#task-rows tr').count(), 3);
  assert.equal(requests, beforeReload);
  // An aged session snapshot should paint complete rows while new details are still blocked.
  await tasks.addInitScript(() => {
    if (sessionStorage.getItem('testAgeCache')) {
      const entries = JSON.parse(sessionStorage.getItem('githubTaskTrackerDetails'));
      for (const [, entry] of entries) entry.time = Date.now() - 6 * 60 * 1000;
      sessionStorage.setItem('githubTaskTrackerDetails', JSON.stringify(entries));
      sessionStorage.removeItem('testAgeCache');
    }
  });
  await tasks.evaluate(() => sessionStorage.setItem('testAgeCache', 'yes'));
  gate = new Promise(resolve => { release = resolve; });
  await tasks.reload();
  await tasks.locator('#task-rows tr').first().waitFor();
  assert.equal(await tasks.locator('#task-results').getAttribute('aria-busy'), 'true');
  assert.ok((await titles()).every(title => title.startsWith('Revision 2')));
  gate = undefined; release(); await settled();
  assert.equal(requests, beforeReload + 28);
  // Corruption before scripts start must not prevent loading authoritative saved tasks.
  await tasks.addInitScript(() => sessionStorage.setItem('githubTaskTrackerDetails', '{invalid'));
  await tasks.reload(); await settled();
  assert.equal(await tasks.locator('#task-rows tr').count(), 25);
  assert.equal(requests, beforeReload + 56);
  // Repository ordering must show the same progress UI when refreshing just the visible page.
  await tasks.locator('#sort-field').selectOption(''); await settled();
  gate = new Promise(resolve => { release = resolve; });
  await tasks.locator('#refresh-details').click();
  assert.equal(await tasks.locator('#refresh-status').isVisible(), true);
  assert.match(await tasks.locator('#sort-progress').textContent(), /Refreshing 0 \/ 25 PRs/);
  assert.equal(await tasks.locator('#refresh-details').isDisabled(), true);
  gate = undefined; release(); await settled();
  assert.equal(await tasks.locator('#refresh-status').isVisible(), false);
  assert.equal(await tasks.locator('#refresh-details').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: unchanged-state reconnects, background refresh without blank rows, cached details and selection retained, tab switching, refresh failure/retry, session cache reload/pagination, and corrupt-cache recovery.');
} finally {
  release?.();
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
