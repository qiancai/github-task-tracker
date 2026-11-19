import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const store = process.argv.includes('--store');
const screenshotDir = join(root, store ? 'dist/store/screenshots' : 'docs/screenshots');
await mkdir(screenshotDir, { recursive: true });
const fixture = await readFile(join(root, 'docs/fixtures/github-pulls.html'), 'utf8');
const detailFixture = await readFile(join(root, 'docs/fixtures/github-pull.html'), 'utf8');
const profile = await mkdtemp(join(tmpdir(), 'gtt-screenshots-'));
let context;
let holdRefresh;
let releaseRefresh;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    executablePath: process.env.GTT_CHROME_EXECUTABLE,
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: store ? { width: 1280, height: 800 } : { width: 1320, height: 930 },
    colorScheme: 'light'
  });
  // Fulfill synthetic pages/details only; block all real GitHub traffic.
  await context.route(/^https?:\/\//, async route => {
    if (route.request().url() === 'https://github.com/example-org/sample-project/pulls') {
      return route.fulfill({ contentType: 'text/html', body: fixture });
    }
    const match = new URL(route.request().url()).pathname.match(/^\/(example-org\/sample-project|example-org\/sample-docs|example-labs\/demo-service)\/pull\/(\d+)$/);
    const number = Number(match?.[2]);
    if (match && route.request().resourceType() === 'fetch') {
      if (holdRefresh) await holdRefresh;
      const titles = { 106: 'docs: add a quickstart guide', 105: 'fix: handle an empty search query', 104: 'feat: add keyboard shortcuts', 103: 'refactor: simplify settings validation', 101: 'docs: update the installation steps', 42: 'docs: explain the upgrade workflow', 17: 'fix: improve retry handling' };
      const pullRequest = { number, title: titles[number] || `Example change ${number}`, author: { login: number === 106 ? 'demo-alex' : number === 17 ? 'demo-jordan' : 'demo-sam' }, baseBranch: number === 42 ? 'release-1.0' : 'main', headBranch: 'example-source-branch', state: number === 101 ? 'MERGED' : 'OPEN' };
      return route.fulfill({ contentType: 'text/html', body: `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { pullRequestsLayoutRoute: { pullRequest } } })}</script>` });
    }
    if (number) return route.fulfill({ contentType: 'text/html', body: detailFixture });
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const settings = await context.newPage();
  await settings.goto(worker.url().replace('/src/background.js', '/settings.html'));
  await settings.waitForSelector('.label-row');
  await settings.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', type: 'get' });
    const state = response.data;
    state.labels.push({ id: 'follow-today', name: 'follow up today', color: '#9a6700' });
    state.pullRequests = {
      'example-org/sample-project#106': ['wait-review', 'follow-today'],
      'example-org/sample-project#101': ['wait-review'],
      'example-org/sample-project#105': ['pending-self', 'follow-today'],
      'example-org/sample-project#104': ['pending-engineer'],
      'example-org/sample-project#103': ['ready-merge'],
      'example-org/sample-docs#42': ['follow-today'],
      'example-labs/demo-service#17': ['follow-today']
    };
    state.notes = { 'example-org/sample-project#106': 'Confirm the example before the next review.', 'example-org/sample-docs#42': 'Follow up with the author on Friday.' };
    const saved = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', type: 'replace', state });
    if (!saved.ok) throw new Error(saved.error);
  });
  const page = await context.newPage();
  await page.goto('https://github.com/example-org/sample-project/pulls');
  await page.waitForSelector('[data-gtt="example-org/sample-project#106"]');
  assert.equal(await page.locator('[data-gtt]').count(), 6);
  assert.equal(await page.locator('img').count(), 0);
  assert.ok(!(await page.content()).match(/pingcap|ti-chi|24528|24621/i));
  await page.screenshot({ path: join(screenshotDir, 'github-list.png') });

  // Reuse the same synthetic page for the inline-creation screenshot.
  const cdp = await context.newCDPSession(page);
  async function shadowObject(filter = false) {
    const { root: document } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const nodes = [];
    function walk(node) { nodes.push(node); for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child); }
    walk(document);
    const host = nodes.find(node => filter ? node.attributes?.includes('data-gtt-filter') : node.attributes?.some((value, index, attributes) => value === 'data-gtt' && attributes[index + 1] === 'example-org/sample-project#106'));
    return (await cdp.send('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId })).object;
  }
  let object = await shadowObject();
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function() { this.querySelector('.label-name').click(); }`
  });
  await page.waitForSelector('[data-gtt-filter]');
  await page.screenshot({ path: join(screenshotDir, 'label-prs.png') });
  object = await shadowObject(true);
  await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function() { this.querySelector('.clear').click(); }` });
  await page.waitForSelector('[data-gtt="example-org/sample-project#106"]');
  object = await shadowObject();
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function() {
      this.querySelector('summary').click();
      this.querySelector('.create-toggle').click();
      this.querySelector('.create-fields input[type=text]').value = 'Pending by designer';
      this.querySelector('.create-fields input[type=color]').value = '#facc15';
    }`
  });
  await page.screenshot({ path: join(screenshotDir, 'inline-create.png') });

  // The settings preview is also fictional, including the repository and PR number.
  await settings.reload();
  await settings.waitForSelector('.label-row');
  await settings.locator('.mock-row strong').evaluate(node => { node.textContent = 'docs: add a quickstart guide'; });
  await settings.locator('.mock-row small').evaluate(node => { node.textContent = '#106 opened in example-org/sample-project'; });
  await settings.screenshot({ path: join(screenshotDir, 'settings.png'), fullPage: !store });
  await page.goto('https://github.com/example-org/sample-project/pull/106');
  await page.waitForSelector('[data-gtt][data-placement=sidebar]');
  assert.equal(await page.locator('[data-gtt]').count(), 1);
  assert.equal(await page.locator('img').count(), 0);
  await page.screenshot({ path: join(screenshotDir, 'github-pr.png'), fullPage: !store });
  const tasks = await context.newPage();
  await tasks.goto(worker.url().replace('/src/background.js', '/tasks.html#label=follow-today'));
  await tasks.waitForSelector('#task-results[aria-busy="false"]');
  assert.equal(await tasks.locator('#task-rows tr').count(), 4);
  const headerBounds = page => page.locator('header').evaluate(header => { const rect = header.getBoundingClientRect(); return { left: rect.left, width: rect.width }; });
  assert.deepEqual(await headerBounds(tasks), await headerBounds(settings), 'Both tabs must keep the same header alignment and width');
  assert.equal(await tasks.locator('#task-rows img').count(), 0);
  await tasks.screenshot({ path: join(screenshotDir, 'my-tasks.png'), fullPage: !store });
  holdRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  await tasks.locator('#refresh-details').click();
  await tasks.screenshot({ path: join(screenshotDir, 'my-tasks-refresh.png'), fullPage: !store });
  holdRefresh = undefined; releaseRefresh();
  await tasks.waitForSelector('#task-results[aria-busy="false"]');
  await tasks.locator('[data-key="example-org/sample-project#106"] .task-note').click();
  await tasks.screenshot({ path: join(screenshotDir, 'my-tasks-note.png'), fullPage: !store });
  await tasks.locator('#cancel-note').click();
  await tasks.locator('[data-key="example-org/sample-project#106"] .task-add-label').click();
  await tasks.screenshot({ path: join(screenshotDir, 'my-tasks-label-picker.png'), fullPage: !store });
  await tasks.locator('#cancel-add-labels').click();
  await tasks.locator('.task-checkbox').nth(0).check();
  await tasks.locator('.task-checkbox').nth(1).check();
  await tasks.locator('#bulk-add-labels').click();
  await tasks.locator('#add-label-choices input[value="pending-self"]').check();
  await tasks.screenshot({ path: join(screenshotDir, 'my-tasks-bulk.png'), fullPage: !store });
  console.log(`Generated fictional screenshots in ${screenshotDir}; no live GitHub requests or real avatars used.`);
} finally {
  releaseRefresh?.();
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
