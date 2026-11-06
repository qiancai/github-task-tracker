const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'gtt-native-filter-'));
const fixture = (await readFile(join(root, 'docs/fixtures/github-pulls.html'), 'utf8')).replaceAll('example-org/sample-project', 'demo-org/project');
const detail = (await readFile(join(root, 'docs/fixtures/github-pull.html'), 'utf8')).replaceAll('example-org/sample-project', 'demo-org/project');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.GTT_CHROME_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1320, height: 930 }
  });
  const errors = [];
  const requests = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://github.com/**', route => {
    const request = route.request();
    requests.push({ url: request.url(), type: request.resourceType() });
    const url = new URL(request.url());
    let body = /\/pull\/\d+$/.test(url.pathname) ? detail : fixture;
    if (url.searchParams.get('page') === '2') for (let number = 101; number <= 106; number++) body = body.replace(`[${number},`, `[${number + 100},`);
    body = body.replace('</main>', `<nav aria-label="Pagination"><a id="previous" href="${url.pathname}?q=is%3Apr+is%3Aopen&page=1">Previous</a> <a id="next" href="${url.pathname}?q=is%3Apr+is%3Aopen&page=2">Next</a></nav></main>`);
    return route.fulfill({ contentType: 'text/html', body });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const settings = await context.newPage();
  await settings.goto(worker.url().replace('/src/background.js', '/settings.html'));
  await settings.waitForSelector('.label-row');
  const send = operation => settings.evaluate(async operation => {
    const response = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', ...operation });
    if (!response.ok) throw new Error(response.error);
    return response.data;
  }, operation);
  const initial = await send({ type: 'get' });
  initial.pullRequests = {
    'demo-org/project#106': ['wait-review'], 'demo-org/project#101': ['wait-review'],
    'demo-org/project#105': ['pending-self'], 'demo-org/project#206': ['wait-review'],
    'demo-org/project#99999': ['wait-review'], 'demo-org/other#101': ['wait-review']
  };
  await send({ type: 'replace', state: initial });
  const page = await context.newPage();
  const sessions = new Map();
  async function shadow(kind, fn, key = 'demo-org/project#106') {
    let cdp = sessions.get(page);
    if (!cdp) { cdp = await context.newCDPSession(page); sessions.set(page, cdp); }
    const { root: document } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const nodes = [];
    function walk(node) { nodes.push(node); for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child); }
    walk(document);
    const attribute = (node, name) => { const index = node.attributes?.indexOf(name); return index >= 0 ? node.attributes[index + 1] : undefined; };
    const host = nodes.find(node => kind === 'filter' ? attribute(node, 'data-gtt-filter') !== undefined : attribute(node, 'data-gtt') === key);
    assert.ok(host, `Missing ${kind} shadow host`);
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function(){return (${fn})(this);}`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(predicate, message) {
    for (let attempt = 0; attempt < 120; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(message);
  }
  const visible = () => page.locator('#rows > li').evaluateAll(rows => rows.filter(row => getComputedStyle(row).display !== 'none').map(row => row.querySelector('[data-testid="listitem-title-link"]').getAttribute('href')));
  const count = () => shadow('filter', 'root=>root.querySelector(".count").textContent');
  await page.goto('https://github.com/demo-org/project/pulls?q=is%3Apr+is%3Aopen');
  await page.waitForSelector('[data-gtt="demo-org/project#106"]');
  const originalQuery = new URL(page.url()).search;
  const originalNext = await page.locator('#next').getAttribute('href');
  const originalRows = await page.locator('#rows > li').evaluateAll(rows => {
    window.originalRows = rows;
    window.nativeClicks = 0;
    const button = document.createElement('button'); button.id = 'native-checks'; button.textContent = '3 checks';
    button.addEventListener('click', () => window.nativeClicks++);
    rows[0].append(button);
    return rows.map(row => { const copy = row.cloneNode(true); copy.querySelectorAll('[data-gtt]').forEach(node => node.remove()); return copy.innerHTML; });
  });
  await page.locator('#rows > li').nth(1).evaluate(row => row.style.setProperty('display', 'grid', 'important'));
  await shadow('widget', 'root=>root.querySelector(".label-name[data-label-id=wait-review]").click()');
  await page.waitForSelector('[data-gtt-filter]');
  await until(async () => (await visible()).length === 2, 'Native rows were not filtered');
  assert.deepEqual(await visible(), ['/demo-org/project/pull/106', '/demo-org/project/pull/101']);
  assert.equal(await count(), '2 of 6 PRs on this page');
  assert.equal(await page.locator('#rows > li').count(), 6, 'Native rows were replaced');
  assert.equal(await page.locator('#rows > li').evaluateAll(rows => rows.every((row, index) => row === window.originalRows[index])), true, 'Native node identity changed');
  const filteredRows = await page.locator('#rows > li').evaluateAll(rows => rows.map(row => { const copy = row.cloneNode(true); copy.querySelectorAll('[data-gtt]').forEach(node => node.remove()); return copy.innerHTML; }));
  assert.deepEqual(filteredRows, originalRows, 'Original PR information was modified');
  await page.locator('#native-checks').click();
  assert.equal(await page.evaluate(() => window.nativeClicks), 1, 'Native event handlers were lost');
  assert.equal(requests.some(request => request.type === 'fetch'), false, 'Filtering fetched extra PR metadata');
  assert.equal(new URL(page.url()).search, originalQuery);
  assert.ok((await page.locator('#next').getAttribute('href')).includes('#private-label=wait-review'));
  await shadow('filter', 'root=>root.querySelector(".clear").click()');
  await until(async () => await page.locator('[data-gtt-filter]').count() === 0, 'Clearing failed');
  assert.equal((await visible()).length, 6);
  assert.equal(await page.locator('#rows > li').nth(1).evaluate(row => row.style.getPropertyValue('display')), 'grid');
  assert.equal(await page.locator('#rows > li').nth(1).evaluate(row => row.style.getPropertyPriority('display')), 'important');
  assert.equal(await page.locator('#next').getAttribute('href'), originalNext);
  await page.goBack(); await page.waitForSelector('[data-gtt-filter]');
  await until(async () => (await visible()).length === 2, 'Back did not restore filtering');
  await page.goForward(); await until(async () => (await visible()).length === 6, 'Forward did not restore the native list');
  // Active filtering follows local assignment changes without rebuilding native rows.
  await shadow('widget', 'root=>root.querySelector(".label-name[data-label-id=wait-review]").click()');
  await page.waitForSelector('[data-gtt-filter]');
  await shadow('widget', 'root=>root.querySelector(".remove-label[data-label-id=wait-review]").click()');
  await until(async () => (await visible()).length === 1, 'Cross removal did not hide the row');
  await send({ type: 'setLabel', key: 'demo-org/project#101', labelId: 'wait-review', selected: false });
  await until(async () => (await visible()).length === 0, 'Removing the last match did not empty this page');
  assert.equal(await count(), '0 of 6 PRs on this page');
  assert.match(await shadow('filter', 'root=>root.querySelector(".empty").textContent'), /No PRs on this page/);
  // A client router that discards href fragments must not lose the filter on pagination.
  await page.locator('#next').evaluate(link => link.addEventListener('click', event => { event.preventDefault(); location.assign('/demo-org/project/pulls?page=2'); }));
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('page') === '2' && url.hash.includes('private-label=wait-review'));
  await page.waitForSelector('[data-gtt-filter]');
  await until(async () => (await visible()).length === 1, 'Second page filter failed');
  assert.deepEqual(await visible(), ['/demo-org/project/pull/206']);
  assert.equal(await count(), '1 of 6 PRs on this page');
  await page.reload(); await page.waitForSelector('[data-gtt-filter]');
  await until(async () => (await visible()).length === 1, 'Reload lost filtering');
  // Dynamically inserted or replaced rows are filtered without losing their native content.
  await send({ type: 'setLabel', key: 'demo-org/project#207', labelId: 'wait-review', selected: true });
  await page.evaluate(() => {
    const row = document.createElement('li');
    row.innerHTML = '<div><h3><a data-testid="listitem-title-link" href="/demo-org/project/pull/207">Dynamic native PR</a></h3><span>Reviewer, checks, and author metadata</span></div>';
    document.querySelector('#rows').append(row);
  });
  await until(async () => (await visible()).length === 2, 'Dynamic native row was not included');
  await page.evaluate(() => {
    const old = document.querySelector('#rows');
    const copy = old.cloneNode(true);
    copy.querySelectorAll('[data-gtt]').forEach(node => node.remove());
    for (const row of copy.children) row.style.removeProperty('display');
    old.replaceWith(copy);
  });
  await until(async () => (await visible()).length === 2 && await page.locator('[data-gtt-filter]').count() === 1, 'Native list replacement broke filtering');
  assert.equal(await count(), '2 of 7 PRs on this page');
  await send({ type: 'saveLabel', label: { id: 'wait-review', name: 'Ready for review', color: '#8250df' } });
  await until(async () => (await shadow('filter', 'root=>root.querySelector("strong").textContent')).includes('Ready for review'), 'Filter rename not updated');
  await send({ type: 'deleteLabel', labelId: 'wait-review' });
  await until(async () => (await visible()).length === 0, 'Deleted active label left stale matches');
  assert.match(await shadow('filter', 'root=>root.querySelector(".empty").textContent'), /deleted/);
  await shadow('filter', 'root=>root.querySelector(".clear-all").click()');
  await until(async () => (await visible()).length === 7, 'Clear did not restore replaced rows');
  // Personal lists stay on the current page and retain the clicked PR's repository scope.
  await send({ type: 'replace', state: initial });
  await page.goto('https://github.com/pulls');
  await page.waitForSelector('[data-gtt="demo-org/project#106"]');
  await page.locator('#rows > li').last().locator('[data-testid="listitem-title-link"]').evaluate(link => { link.href = '/demo-org/other/pull/101'; });
  await shadow('widget', 'root=>root.querySelector(".label-name").click()');
  await page.waitForURL(url => url.pathname === '/pulls' && url.hash.includes('private-repo=demo-org%2Fproject'));
  await until(async () => (await visible()).length === 1, 'Personal list repository scope failed');
  assert.deepEqual(await visible(), ['/demo-org/project/pull/106']);
  // Detail pages navigate to the repository's ordinary list before applying the same filter.
  await page.goto('https://github.com/demo-org/project/pull/106');
  await page.waitForSelector('[data-gtt][data-placement=sidebar]');
  await shadow('widget', 'root=>root.querySelector(".label-name").click()');
  await page.waitForURL('https://github.com/demo-org/project/pulls#private-label=wait-review');
  await page.waitForSelector('[data-gtt-filter]');
  await until(async () => (await visible()).length === 2, 'Detail-to-list filtering failed');
  // A label created and applied in the detail editor must immediately support the same navigation.
  await page.goto('https://github.com/demo-org/project/pull/106');
  await page.waitForSelector('[data-gtt][data-placement=sidebar]');
  await shadow('widget', 'root=>root.querySelector("summary").click()');
  await shadow('widget', 'root=>root.querySelector(".create-toggle").click()');
  await shadow('widget', 'root=>{root.querySelector(".create-fields input[type=text]").value="follow up today";}');
  await shadow('widget', 'root=>root.querySelector(".create-submit").click()');
  await until(async () => (await send({ type: 'get' })).labels.some(label => label.name === 'follow up today'), 'Detail label creation failed');
  const createdId = (await send({ type: 'get' })).labels.find(label => label.name === 'follow up today').id;
  await until(() => shadow('widget', `root=>[...root.querySelectorAll('.label-name')].some(button=>button.dataset.labelId===${JSON.stringify(createdId)})`), 'New label chip was not displayed');
  await shadow('widget', `root=>[...root.querySelectorAll('.label-name')].find(button=>button.dataset.labelId===${JSON.stringify(createdId)}).click()`);
  await page.waitForURL(url => url.pathname === '/demo-org/project/pulls' && new URLSearchParams(url.hash.slice(1)).get('private-label') === createdId);
  await page.waitForSelector('[data-gtt-filter]');
  await until(async () => (await visible()).length === 1, 'New detail label did not filter the repository list');
  assert.deepEqual(await visible(), ['/demo-org/project/pull/106']);
  assert.match(await shadow('filter', 'root=>root.querySelector("strong").textContent'), /follow up today/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('[data-gtt-filter]').evaluate(node => node.getBoundingClientRect().width <= innerWidth), 'Filter bar overflows viewport');
  assert.equal(requests.some(request => request.type === 'fetch'), false);
  assert.equal(requests.some(request => request.url.includes('private-label')), false, 'Filter ID was sent in a network URL');
  assert.deepEqual(errors, []);
  console.log('PASS: original native rows, complete information and handlers preserved; page-only hiding, exact clear/style restore, native query and pagination, back/forward/reload, live changes, dynamic rows, repository scope, and zero metadata requests.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
