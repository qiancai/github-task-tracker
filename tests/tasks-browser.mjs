const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'gtt-tasks-'));
const legacy = await readFile(join(root, 'docs/fixtures/github-pull.html'), 'utf8');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.GTT_CHROME_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1320, height: 950 }
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let unavailable = true;
  let active = 0;
  let maximum = 0;
  const requests = [];
  const counts = new Map();
  function modern(key) {
    const number = Number(key.split('#')[1]);
    const other = key.startsWith('demo-org/another#');
    const pullRequest = {
      number, title: `Example change ${number}`, author: { login: other ? 'demo-sam' : 'demo-alex' },
      baseBranch: other ? 'master' : 'release-8.5', headBranch: 'feature/not-the-base', state: other ? 'MERGED' : 'OPEN'
    };
    return `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { pullRequestsLayoutRoute: { pullRequest } } })}</script>`;
  }
  await context.route('https://github.com/**', async route => {
    const request = route.request();
    requests.push(request.url());
    const path = new URL(request.url()).pathname;
    const match = path.match(/^\/(demo-org\/[^/]+)\/pull\/(\d+)$/);
    if (!match) return route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' });
    if (request.resourceType() !== 'fetch') return route.fulfill({ contentType: 'text/html', body: legacy });
    const key = `${match[1]}#${match[2]}`;
    active++; maximum = Math.max(maximum, active); counts.set(key, (counts.get(key) || 0) + 1);
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (key.endsWith('#103') && unavailable) return await route.fulfill({ status: 404, body: 'Not found' });
      if (key.startsWith('demo-org/third#')) return await route.fulfill({ status: 302, headers: { location: '/login' } });
      return await route.fulfill({ contentType: 'text/html', body: key.endsWith('#102') ? legacy : modern(key) });
    } catch { /* Filter changes can abort pending detail requests. */ }
    finally { active--; }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = worker.url().replace('/src/background.js', '');
  const settings = await context.newPage(); await settings.goto(base + '/settings.html'); await settings.waitForSelector('.label-row');
  const send = operation => settings.evaluate(async operation => {
    const response = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', ...operation });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }, operation);
  const initial = await send({ type: 'get' });
  initial.labels.push({ id: 'follow-today', name: 'follow up today', color: '#9a6700' });
  initial.pullRequests = {
    'demo-org/project#101': ['follow-today', 'pending-self'], 'demo-org/another#101': ['follow-today'],
    'demo-org/project#102': ['wait-review'], 'demo-org/project#103': ['follow-today'], 'demo-org/third#999': ['follow-today']
  };
  await send({ type: 'replace', state: initial });
  const opened = context.waitForEvent('page'); await send({ type: 'openTasks' });
  const tasks = await opened; await tasks.waitForURL(base + '/tasks.html');
  await tasks.locator('#task-results[aria-busy="false"]').waitFor();
  const rows = () => tasks.locator('#task-rows tr');
  const row = key => tasks.locator(`#task-rows tr[data-key="${key}"]`);
  const settled = () => tasks.locator('#task-results[aria-busy="false"]').waitFor();
  async function until(predicate, message) {
    for (let index = 0; index < 150; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(message);
  }
  assert.equal(await tasks.locator('#sort-field').inputValue(), 'title');
  assert.match(await tasks.locator('#sort-direction').textContent(), /Ascending/);
  assert.equal(await rows().count(), 5);
  assert.equal(await tasks.locator('#task-count').textContent(), '5 PRs across 3 repositories');
  assert.equal(await row('demo-org/project#101').locator('.task-title').textContent(), 'Example change 101');
  assert.deepEqual(await tasks.locator('.task-table th').evaluateAll(headers => headers.map(header => header.innerText.trim().replace(/\s+/g, ' '))), ['', 'Pull request ↑', 'Author ↕', 'Base branch ↕', 'Private labels', 'Notes']);
  assert.equal(await row('demo-org/project#101').locator('.task-repository').textContent(), 'demo-org/project');
  assert.equal(await row('demo-org/project#101').locator('.task-number').textContent(), '#101');
  assert.deepEqual(await row('demo-org/project#101').locator('.task-heading').evaluate(heading => [...heading.children].map(item => item.className)), ['task-files', 'task-title', 'task-reference']);
  assert.deepEqual(await row('demo-org/project#101').locator('.task-reference').evaluate(reference => [...reference.children].map(item => item.className)), ['task-repository', 'task-number', 'task-state']);
  assert.ok(await row('demo-org/project#101').evaluate(row => {
    const files = row.querySelector('.task-files').getBoundingClientRect();
    const title = row.querySelector('.task-title').getBoundingClientRect();
    const number = row.querySelector('.task-number').getBoundingClientRect();
    return files.right <= title.left && title.right <= number.left && Math.abs(files.top - title.top) < 5;
  }), 'Files, title and number must share a compact horizontal heading');
  assert.equal(await row('demo-org/project#101').locator('.author-name').textContent(), 'demo-alex');
  assert.equal(await row('demo-org/project#101').locator('.base-name').textContent(), 'release-8.5');
  assert.equal(await row('demo-org/another#101').locator('.author-name').textContent(), 'demo-sam');
  assert.equal(await row('demo-org/another#101').locator('.base-name').textContent(), 'master');
  assert.equal(await row('demo-org/another#101').locator('.task-state').textContent(), 'Merged');
  assert.equal(await row('demo-org/project#102').locator('.base-name').textContent(), 'main', 'Legacy base must not be the source branch');
  assert.equal(await row('demo-org/project#103').locator('.task-title').textContent(), 'PR #103');
  assert.equal(await row('demo-org/project#103').locator('.task-files').getAttribute('href'), 'https://github.com/demo-org/project/pull/103/files', 'Files link must remain available if metadata fails');
  assert.equal(await row('demo-org/another#101').locator('.task-files').getAttribute('href'), 'https://github.com/demo-org/another/pull/101/files', 'Files link must use the correct repository');
  assert.match(await row('demo-org/project#103').locator('.task-error').textContent(), /HTTP 404/);
  assert.match(await row('demo-org/third#999').locator('.task-error').textContent(), /redirected/);
  assert.ok(maximum <= 4);
  assert.equal(requests.some(url => /follow-today|follow%20up|private-label/.test(url)), false);
  // Filtering covers all local repositories and does not repeat fresh cached requests.
  const beforeFilters = [...counts.values()].reduce((sum, value) => sum + value, 0);
  await tasks.locator('#label-filter').selectOption('follow-today'); await settled();
  assert.equal(await rows().count(), 4);
  await tasks.locator('#repo-filter').selectOption('demo-org/project'); await settled();
  assert.equal(await rows().count(), 2);
  assert.equal([...counts.values()].reduce((sum, value) => sum + value, 0), beforeFilters);
  unavailable = false;
  await row('demo-org/project#103').getByRole('button', { name: 'Retry details' }).click(); await settled();
  assert.equal(await row('demo-org/project#103').locator('.base-name').textContent(), 'release-8.5');
  assert.equal([...counts.values()].reduce((sum, value) => sum + value, 0), beforeFilters + 1);
  // Failed removals preserve saved data; successful removals affect only this PR assignment.
  const beforeFailure = JSON.stringify(await send({ type: 'get' }));
  await worker.evaluate(() => { globalThis.originalSet = chrome.storage.local.set; chrome.storage.local.set = () => Promise.reject(new Error('Simulated storage failure')); });
  try {
    await row('demo-org/project#101').getByRole('button', { name: 'Remove follow up today from demo-org/project#101', exact: true }).click();
    await until(async () => (await tasks.locator('#notice').textContent()).includes('Simulated storage failure'), 'Removal failure not shown');
    assert.equal(JSON.stringify(await send({ type: 'get' })), beforeFailure);
  } finally { await worker.evaluate(() => { chrome.storage.local.set = globalThis.originalSet; delete globalThis.originalSet; }); }
  await row('demo-org/project#101').getByRole('button', { name: 'Remove follow up today from demo-org/project#101', exact: true }).click();
  await until(async () => await rows().count() === 1, 'Task was not removed from the selected-label results');
  assert.deepEqual((await send({ type: 'get' })).pullRequests['demo-org/project#101'], ['pending-self']);
  assert.deepEqual((await send({ type: 'get' })).pullRequests['demo-org/another#101'], ['follow-today']);
  await send({ type: 'setLabel', key: 'demo-org/project#104', labelId: 'follow-today', selected: true });
  await until(async () => await rows().count() === 2, 'External assignment did not update My tasks'); await settled();
  await send({ type: 'saveLabel', label: { id: 'follow-today', name: 'follow up tomorrow', color: '#9a6700' } });
  await until(async () => (await tasks.locator('#label-filter option:checked').textContent()) === 'follow up tomorrow', 'Rename lost the filter');
  await send({ type: 'deleteLabel', labelId: 'follow-today' });
  await until(async () => await rows().count() === 0, 'Deleted label left stale tasks');
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click(); await settled();
  assert.equal(await rows().count(), 2, 'Other label assignments were lost');
  // The settings label usage link opens a cross-repository filtered task page.
  const usage = settings.getByRole('link', { name: 'View PRs with Pending by me across repositories', exact: true });
  await usage.click(); await settings.waitForURL(/tasks.html#label=pending-self$/); await settings.locator('#task-results[aria-busy="false"]').waitFor();
  assert.equal(await settings.locator('#task-rows tr').count(), 1);
  await settings.goto(base + '/settings.html'); await settings.waitForSelector('.label-row');
  await tasks.locator('#sort-field').selectOption(''); await settled();
  // All local records are paginated, including PRs never opened in a GitHub list.
  const bulk = structuredClone(initial);
  bulk.pullRequests = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`demo-org/project#${200 + index}`, ['wait-review']]));
  await send({ type: 'replace', state: bulk });
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click(); await settled();
  assert.equal(await rows().count(), 25);
  assert.equal(await tasks.locator('#page-count').textContent(), 'Page 1 of 2');
  // Sorting covers the entire filtered index before pagination, including uncached off-page PRs.
  await tasks.locator('#select-page').check();
  await tasks.locator('[data-sort="title"]').click(); await settled();
  assert.equal(await rows().first().getAttribute('data-key'), 'demo-org/project#200');
  assert.equal(await tasks.locator('#selected-count').textContent(), '0 selected on this page');
  assert.equal(await tasks.locator('[data-sort="title"]').locator('..').getAttribute('aria-sort'), 'ascending');
  assert.equal(counts.has('demo-org/project#200'), true, 'Off-page details must be loaded for global sorting');
  const sortedRequests = requests.length;
  await tasks.locator('[data-sort="title"]').click(); await settled();
  assert.equal(await rows().first().getAttribute('data-key'), 'demo-org/project#227');
  assert.equal(requests.length, sortedRequests, 'Direction changes must reuse cached metadata');
  await tasks.locator('#sort-field').selectOption(''); await settled();
  await tasks.getByRole('button', { name: 'Next', exact: true }).click(); await settled();
  assert.equal(await rows().count(), 3);
  assert.equal(await tasks.locator('#page-count').textContent(), 'Page 2 of 2');
  // Parser security and source/base distinction, without executing remote HTML.
  const parsed = await tasks.evaluate(async () => {
    const { parsePRMetadata } = await import('./src/pr-metadata.js');
    const data = { number: 1, title: '<img src=x onerror=alert(1)>', author: { login: 'demo' }, headBranch: 'wrong-source', state: 'OPEN' };
    const html = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { pullRequestsLayoutRoute: { pullRequest: data } } })}</script>`;
    const result = parsePRMetadata(html, 'demo-org/project#1');
    let mismatch = false;
    try { parsePRMetadata(html, 'demo-org/project#2'); } catch { mismatch = true; }
    return { result, mismatch };
  });
  assert.equal(parsed.result.title, '<img src=x onerror=alert(1)>');
  assert.equal(parsed.result.base, '', 'Missing base incorrectly used the head branch');
  assert.equal(parsed.mismatch, true);
  assert.equal(await tasks.locator('#task-rows img, #task-rows script').count(), 0);
  const openPR = context.waitForEvent('page'); await rows().first().locator('.task-title').click();
  const pr = await openPR; await pr.waitForURL('https://github.com/demo-org/project/pull/202');
  const openFiles = context.waitForEvent('page'); await rows().first().locator('.task-files').click();
  const filesPage = await openFiles; await filesPage.waitForURL('https://github.com/demo-org/project/pull/202/files');
  await tasks.setViewportSize({ width: 390, height: 844 }); await tasks.emulateMedia({ colorScheme: 'dark' });
  assert.ok(await tasks.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Tasks page overflows on mobile');
  await mkdir(join(root, 'test-results'), { recursive: true });
  await tasks.screenshot({ path: join(root, 'test-results/tasks-mobile.png'), fullPage: true });
  await send({ type: 'replace', state: initial }); await settled();
  await tasks.locator('#sort-field').selectOption('author'); await settled();
  const values = selector => tasks.locator(selector).allTextContents();
  assert.deepEqual(await values('.author-name'), ['demo-alex', 'demo-alex', 'demo-alex', 'demo-sam', 'Unavailable']);
  await tasks.locator('#sort-direction').click(); await settled();
  assert.deepEqual(await values('.author-name'), ['demo-sam', 'demo-alex', 'demo-alex', 'demo-alex', 'Unavailable']);
  await tasks.locator('#sort-field').selectOption('base'); await settled();
  assert.deepEqual(await values('.base-name'), ['main', 'master', 'release-8.5', 'release-8.5', 'Unavailable']);
  await tasks.locator('#sort-direction').click(); await settled();
  assert.deepEqual(await values('.base-name'), ['release-8.5', 'release-8.5', 'master', 'main', 'Unavailable']);
  await tasks.locator('#sort-field').selectOption('title'); await settled();
  const titles = await values('.task-title');
  const firstSameTitle = titles.indexOf('Example change 101');
  assert.equal(titles[firstSameTitle + 1], 'Example change 101', 'Same titles from different repositories should be adjacent');
  await tasks.locator('#repo-filter').selectOption('demo-org/project'); await settled();
  assert.equal(await rows().count(), 3);
  assert.match(tasks.url(), /sort=title/);
  await tasks.reload(); await settled();
  assert.equal(await tasks.locator('#sort-field').inputValue(), 'title');
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click(); await settled();
  assert.equal(await rows().count(), 5);
  assert.equal(await tasks.locator('#sort-field').inputValue(), 'title');
  assert.ok(await tasks.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Label names filter locally, preserve repository/sort, and never change stored assignments.
  const beforeLabelClick = JSON.stringify(await send({ type: 'get' }));
  const labelButton = row('demo-org/another#101').getByRole('button', { name: 'Filter by follow up today', exact: true });
  await labelButton.focus(); await tasks.keyboard.press('Enter'); await settled();
  assert.equal(await rows().count(), 4, 'Label click must include matches across repositories');
  assert.equal(await tasks.locator('#label-filter').inputValue(), 'follow-today');
  assert.equal(await tasks.locator('#sort-field').inputValue(), 'title');
  assert.match(tasks.url(), /label=follow-today/);
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click(); await settled();
  await tasks.locator('#repo-filter').selectOption('demo-org/project'); await settled();
  await row('demo-org/project#102').getByRole('button', { name: 'Filter by Wait for review', exact: true }).click(); await settled();
  assert.equal(await rows().count(), 1);
  assert.equal(await tasks.locator('#repo-filter').inputValue(), 'demo-org/project');
  assert.equal(await tasks.locator('#label-filter').inputValue(), 'wait-review');
  assert.equal(JSON.stringify(await send({ type: 'get' })), beforeLabelClick, 'Filtering must not write label assignments');
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click(); await settled();
  assert.equal(await rows().count(), 5);
  // Sorting preferences survive opening a fresh My tasks tab; explicit URL sorting still wins.
  await tasks.locator('#sort-field').selectOption('author'); await settled();
  await tasks.locator('#sort-direction').click(); await settled();
  const reopened = await context.newPage(); await reopened.goto(base + '/tasks.html');
  await reopened.locator('#task-results[aria-busy="false"]').waitFor();
  assert.equal(await reopened.locator('#sort-field').inputValue(), 'author');
  assert.match(await reopened.locator('#sort-direction').textContent(), /Descending/);
  await reopened.reload(); await reopened.locator('#task-results[aria-busy="false"]').waitFor();
  assert.match(await reopened.locator('#sort-direction').textContent(), /Descending/);
  await reopened.goto(base + '/tasks.html#sort=title&direction=asc');
  await reopened.locator('#task-results[aria-busy="false"]').waitFor();
  assert.equal(await reopened.locator('#sort-field').inputValue(), 'title');
  assert.match(await reopened.locator('#sort-direction').textContent(), /Ascending/);
  await reopened.locator('#sort-field').selectOption('');
  await reopened.goto(base + '/tasks.html'); await reopened.locator('#task-results[aria-busy="false"]').waitFor();
  assert.equal(await reopened.locator('#sort-field').inputValue(), '', 'Repository ordering must also be remembered explicitly');
  await reopened.evaluate(() => localStorage.setItem('githubTaskTrackerTaskSort', '{invalid'));
  await reopened.goto(base + '/tasks.html'); await reopened.locator('#task-results[aria-busy="false"]').waitFor();
  assert.equal(await reopened.locator('#sort-field').inputValue(), 'title');
  assert.match(await reopened.locator('#sort-direction').textContent(), /Ascending/);
  await reopened.close();
  await send({ type: 'replace', state: { ...initial, pullRequests: {} } });
  await until(async () => await rows().count() === 0, 'Empty task index was not reflected');
  assert.match(await tasks.locator('#empty-tasks').textContent(), /No tracked PRs/);
  assert.deepEqual(errors, []);
  console.log('PASS: My tasks entry points, all repositories and filters, title/author/base parsing, correct merge-target branch, failures/retry/cache/concurrency, live updates, safe removal, pagination, navigation, empty states, and mobile layout.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
