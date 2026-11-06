const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'gtt-task-labels-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.GTT_CHROME_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1320, height: 950 }
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://github.com/**', route => {
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
  const a = 'demo-org/alpha#101', b = 'demo-org/beta#201', c = 'demo-org/alpha#102';
  initial.pullRequests = { [a]: ['pending-self'], [b]: ['wait-review'], [c]: ['pending-engineer'] };
  await send({ type: 'replace', state: initial });
  const tasks = await context.newPage(); await tasks.goto(base + '/tasks.html');
  await tasks.locator('#task-results[aria-busy="false"]').waitFor();
  const row = key => tasks.locator(`#task-rows tr[data-key="${key}"]`);
  const dialog = tasks.locator('#add-labels-dialog');
  const choice = id => dialog.locator(`input[type=checkbox][value="${id}"]`);
  async function until(predicate, message) {
    for (let index = 0; index < 120; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(message);
  }
  async function openSingle(key) {
    await row(key).getByRole('button', { name: `Edit private labels for ${key}`, exact: true }).click();
    await dialog.waitFor({ state: 'visible' });
  }
  async function fillNewLabel(value) {
    if (!(await dialog.locator('#add-label-name').isVisible())) await dialog.locator('#create-label-toggle').click();
    await dialog.locator('#add-label-name').fill(value);
  }
  async function select(keys) {
    for (const key of keys) await row(key).getByRole('checkbox', { name: `Select ${key}`, exact: true }).check();
  }
  async function openBulk() { await tasks.locator('#bulk-add-labels').click(); await dialog.waitFor({ state: 'visible' }); }
  async function apply() {
    await dialog.getByRole('button', { name: 'Apply labels', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await tasks.locator('#task-results[aria-busy="false"]').waitFor();
  }
  assert.equal(await tasks.locator('#bulk-add-labels').isVisible(), false);
  assert.equal(await tasks.locator('#private-labels-heading').isVisible(), true);
  assert.equal(await tasks.locator('.task-toolbar #bulk-add-labels').count(), 0);
  // Per-row addition supports existing labels plus creating a new shared definition.
  await openSingle(a);
  assert.equal(await dialog.locator('#add-label-name').isVisible(), false, 'Create form should start collapsed');
  assert.equal(await row(a).locator('.task-add-label').getAttribute('aria-expanded'), 'true');
  assert.ok(await dialog.evaluate(panel => {
    const button = [...document.querySelectorAll('#task-rows tr')].find(row => row.dataset.key === 'demo-org/alpha#101').querySelector('.task-add-label');
    return Math.abs(panel.getBoundingClientRect().top - button.getBoundingClientRect().bottom - 6) < 1;
  }), 'Single PR picker should open beside its trigger');
  assert.equal(await dialog.evaluate(panel => Math.round(panel.getBoundingClientRect().width)), 282);
  assert.ok(await row(a).locator('.task-add-label').evaluate(button => {
    const rect = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
    return Math.abs(rect.width - rect.height) < 0.1 && Math.abs(rect.x + rect.width / 2 - icon.x - icon.width / 2) < 0.1 && Math.abs(rect.y + rect.height / 2 - icon.y - icon.height / 2) < 0.1;
  }), 'Plus icon is not centered inside its circle');
  assert.ok(await dialog.evaluate(panel => !panel.matches(':modal')), 'Label picker should not dim or block the page');
  assert.ok(await dialog.evaluate(panel => {
    const rect = panel.getBoundingClientRect();
    return rect.left >= 12 && rect.right <= innerWidth - 12 && rect.top >= 12 && rect.bottom <= innerHeight - 12;
  }), 'Picker extends outside the viewport');
  assert.equal(await dialog.locator('[data-order-id="pending-self"] .picker-label').evaluate(label => getComputedStyle(label).backgroundColor), 'rgb(9, 105, 218)');
  assert.equal(await choice('pending-self').isChecked(), true);
  assert.equal(await choice('pending-self').isDisabled(), false);
  await choice('wait-review').check();
  await fillNewLabel('Pending by designer');
  // Reorder inside an open dialog without losing draft choices or changing PR assignments.
  const assignmentsBeforeMove = JSON.stringify((await send({ type: 'get' })).pullRequests);
  await dialog.getByRole('button', { name: 'Reorder Ready to merge', exact: true }).dragTo(dialog.locator('[data-order-id="wait-review"]'), { targetPosition: { x: 40, y: 2 } });
  await until(async () => (await send({ type: 'get' })).labels[0].id === 'ready-merge', 'Dialog drag was not saved');
  assert.equal(await choice('wait-review').isChecked(), true);
  assert.equal(await dialog.locator('#add-label-name').inputValue(), 'Pending by designer');
  assert.equal(JSON.stringify((await send({ type: 'get' })).pullRequests), assignmentsBeforeMove);
  const beforeOrderFailure = JSON.stringify(await send({ type: 'get' }));
  await worker.evaluate(() => { globalThis.orderOriginalSet = chrome.storage.local.set; chrome.storage.local.set = () => Promise.reject(new Error('Simulated reorder failure')); });
  try {
    await dialog.getByRole('button', { name: 'Reorder Ready to merge', exact: true }).press('Alt+ArrowDown');
    await until(async () => (await dialog.locator('#add-labels-error').textContent()).includes('Simulated reorder failure'), 'Order failure not displayed');
    assert.equal(JSON.stringify(await send({ type: 'get' })), beforeOrderFailure);
    await until(async () => await dialog.getByRole('button', { name: 'Reorder Ready to merge', exact: true }).isEnabled(), 'Order handle stuck disabled');
  } finally { await worker.evaluate(() => { chrome.storage.local.set = globalThis.orderOriginalSet; delete globalThis.orderOriginalSet; }); }
  await dialog.getByRole('button', { name: 'Reorder Ready to merge', exact: true }).press('Alt+ArrowDown');
  await until(async () => (await send({ type: 'get' })).labels[1].id === 'ready-merge', 'Keyboard reorder retry failed');
  await send({ type: 'moveLabel', labelId: 'ready-merge', targetId: 'pending-engineer', after: true });
  await until(async () => await dialog.locator('#add-label-choices > label').last().getAttribute('data-order-id') === 'ready-merge', 'Dialog missed external order update');
  assert.equal(await choice('wait-review').isChecked(), true);
  await apply();
  const designer = (await send({ type: 'get' })).labels.find(label => label.name === 'Pending by designer').id;
  assert.deepEqual((await send({ type: 'get' })).pullRequests[a], ['pending-self', 'wait-review', designer]);
  assert.deepEqual((await send({ type: 'get' })).pullRequests[b], ['wait-review']);
  // Cancel and Escape must not create definitions or assignments.
  const beforeCancel = JSON.stringify(await send({ type: 'get' }));
  await openSingle(a); await choice('pending-engineer').check(); await fillNewLabel('Do not save');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(JSON.stringify(await send({ type: 'get' })), beforeCancel);
  await openSingle(a); await tasks.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(JSON.stringify(await send({ type: 'get' })), beforeCancel);
  await openSingle(a); await choice('ready-merge').check();
  await tasks.locator('h2').click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(JSON.stringify(await send({ type: 'get' })), beforeCancel, 'Outside click applied a draft');
  await row(b).locator('.task-add-label').click();
  assert.equal(await dialog.locator('#add-labels-target').textContent(), b);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Mixed checkboxes show coverage, and applying uses a union rather than replacing labels.
  await select([a, b]);
  assert.equal(await tasks.locator('#bulk-add-labels').isVisible(), true);
  assert.equal(await tasks.locator('#private-labels-heading').isVisible(), false);
  assert.equal(await tasks.locator('th #bulk-add-labels').count(), 1);
  assert.equal(await tasks.locator('#select-all').evaluate(input => input.indeterminate), true);
  await openBulk();
  assert.match(await dialog.locator('#add-labels-title').textContent(), /2 PRs/);
  assert.ok(await dialog.evaluate(panel => Math.abs(panel.getBoundingClientRect().top - document.querySelector('#bulk-add-labels').getBoundingClientRect().bottom - 6) < 1), 'Bulk picker should open beside the Private labels header');
  assert.equal(await choice('wait-review').isChecked(), true);
  assert.equal(await choice('wait-review').isDisabled(), false);
  assert.equal(await choice(designer).evaluate(input => input.indeterminate), true);
  await choice(designer).check(); await choice('pending-engineer').check(); await apply();
  assert.deepEqual(new Set((await send({ type: 'get' })).pullRequests[a]), new Set(['pending-self', 'wait-review', designer, 'pending-engineer']));
  assert.deepEqual(new Set((await send({ type: 'get' })).pullRequests[b]), new Set(['wait-review', designer, 'pending-engineer']));
  assert.deepEqual((await send({ type: 'get' })).pullRequests[c], ['pending-engineer']);
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 0);
  // Remove common and mixed labels together, while adding a new label in the same save.
  await select([a, c]); await openBulk();
  const beforeRemovalCancel = JSON.stringify(await send({ type: 'get' }));
  await choice('pending-engineer').uncheck();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(JSON.stringify(await send({ type: 'get' })), beforeRemovalCancel);
  await openBulk();
  assert.equal(await choice('wait-review').evaluate(input => input.indeterminate), true);
  await choice('wait-review').check(); await choice('wait-review').uncheck();
  await choice('pending-engineer').uncheck();
  assert.match(await choice('wait-review').locator('..').locator('small').getAttribute('aria-label'), /remove from all/);
  await fillNewLabel('Follow up together');
  await send({ type: 'setLabel', key: a, labelId: 'ready-merge', selected: true });
  await until(async () => await choice('ready-merge').evaluate(input => input.indeterminate), 'Concurrent target update missing');
  assert.equal(await choice('pending-engineer').isChecked(), false, 'External update overwrote removal draft');
  await apply();
  const together = (await send({ type: 'get' })).labels.find(label => label.name === 'Follow up together').id;
  assert.deepEqual(new Set((await send({ type: 'get' })).pullRequests[a]), new Set(['pending-self', designer, 'ready-merge', together]));
  assert.deepEqual((await send({ type: 'get' })).pullRequests[c], [together]);
  assert.deepEqual(new Set((await send({ type: 'get' })).pullRequests[b]), new Set(['wait-review', designer, 'pending-engineer']));
  assert.ok((await send({ type: 'get' })).labels.some(label => label.id === 'pending-engineer'), 'Removing assignments must keep the shared definition');
  // Filter changes reset selection and cannot accidentally target hidden rows.
  await select([a]); await tasks.locator('#label-filter').selectOption('pending-self');
  await until(async () => await tasks.locator('#task-rows tr').count() === 1, 'Filter not applied');
  assert.equal(await tasks.locator('#bulk-add-labels').isDisabled(), true);
  assert.equal(await tasks.locator('#bulk-add-labels').isVisible(), false);
  assert.equal(await tasks.locator('#private-labels-heading').isVisible(), true);
  await tasks.locator('#select-page').check();
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 1);
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 0);
  // External updates preserve dialog drafts and the originally reviewed targets.
  await select([a, b]); await openBulk(); await choice('ready-merge').check();
  await fillNewLabel('Draft remains');
  await send({ type: 'setLabel', key: c, labelId: 'ready-merge', selected: true });
  await until(async () => await row(c).getByRole('button', { name: `Remove Ready to merge from ${c}`, exact: true }).count() === 1, 'External update missing');
  assert.equal(await dialog.locator('#add-label-name').inputValue(), 'Draft remains');
  assert.equal(await choice('ready-merge').isChecked(), true);
  assert.match(await dialog.locator('#add-labels-target').textContent(), /2 selected PRs/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // A failed storage write leaves all targets and a proposed new definition unchanged.
  await openBulk(); await choice(designer).uncheck(); await fillNewLabel('Atomic new label');
  const beforeFailure = JSON.stringify(await send({ type: 'get' }));
  await worker.evaluate(() => { globalThis.originalSet = chrome.storage.local.set; chrome.storage.local.set = () => Promise.reject(new Error('Simulated batch failure')); });
  try {
    await dialog.getByRole('button', { name: 'Apply labels', exact: true }).click();
    await until(async () => (await dialog.locator('#add-labels-error').textContent()).includes('Simulated batch failure'), 'Batch failure not shown');
    assert.equal(JSON.stringify(await send({ type: 'get' })), beforeFailure);
    assert.equal(await dialog.locator('#add-label-name').inputValue(), 'Atomic new label');
    assert.equal(await choice(designer).isChecked(), false, 'Removal draft lost after failed save');
  } finally { await worker.evaluate(() => { chrome.storage.local.set = globalThis.originalSet; delete globalThis.originalSet; }); }
  await apply();
  const atomic = (await send({ type: 'get' })).labels.find(label => label.name === 'Atomic new label').id;
  assert.ok((await send({ type: 'get' })).pullRequests[a].includes(atomic));
  assert.ok((await send({ type: 'get' })).pullRequests[b].includes(atomic));
  assert.equal((await send({ type: 'get' })).pullRequests[a].includes(designer), false);
  assert.equal((await send({ type: 'get' })).pullRequests[b].includes(designer), false);
  // A target that became untracked cannot be resurrected by a stale dialog.
  await select([a, b]); await openBulk(); await fillNewLabel('Stale target label');
  for (const id of (await send({ type: 'get' })).pullRequests[a]) await send({ type: 'setLabel', key: a, labelId: id, selected: false });
  const beforeStale = JSON.stringify(await send({ type: 'get' }));
  await dialog.getByRole('button', { name: 'Apply labels', exact: true }).click();
  await until(async () => (await dialog.locator('#add-labels-error').textContent()).includes('no longer tracked'), 'Stale target was not rejected');
  assert.equal(JSON.stringify(await send({ type: 'get' })), beforeStale);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tasks.locator('#sort-field').selectOption('');
  // Select-all is page-scoped. Changing pages discards selection, and mobile retains its own select-page control.
  const bulk = structuredClone(initial);
  bulk.pullRequests = Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`demo-org/alpha#${index + 1}`, ['pending-self']]));
  await send({ type: 'replace', state: bulk });
  await tasks.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await tasks.locator('#task-results[aria-busy="false"]').waitFor();
  await tasks.locator('#select-all').check();
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 25);
  await tasks.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 0);
  assert.equal(await tasks.locator('#bulk-add-labels').isDisabled(), true);
  await tasks.setViewportSize({ width: 390, height: 844 });
  assert.equal(await tasks.locator('#select-page').isVisible(), true);
  await tasks.locator('#select-page').check(); await openBulk(); await choice('ready-merge').check();
  assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().right <= innerWidth), 'Label dialog overflows mobile');
  await apply();
  assert.deepEqual(Object.entries((await send({ type: 'get' })).pullRequests).filter(([, ids]) => ids.includes('ready-merge')).map(([key]) => key).sort(), ['demo-org/alpha#1', 'demo-org/alpha#2', 'demo-org/alpha#3']);
  assert.equal(await tasks.locator('.task-checkbox:checked').count(), 0);
  assert.ok(await tasks.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Selection column overflows mobile');
  // Removing the final labels untracks only the three selected PRs on this page.
  await tasks.locator('#select-page').check(); await openBulk();
  await choice('pending-self').uncheck(); await choice('ready-merge').uncheck();
  assert.equal(await dialog.getByRole('button', { name: 'Apply labels', exact: true }).isEnabled(), true, 'Removal-only edit must be applicable');
  await apply();
  const afterRemoval = await send({ type: 'get' });
  assert.equal(Object.keys(afterRemoval.pullRequests).length, 25);
  for (const number of [1, 2, 3]) assert.equal(Object.hasOwn(afterRemoval.pullRequests, `demo-org/alpha#${number}`), false);
  assert.deepEqual(afterRemoval.labels, bulk.labels);
  assert.deepEqual(errors, []);
  console.log('PASS: single and bulk label editing, common/mixed removals, combined add/remove/create, untouched concurrent assignments, removal-only cleanup, cancel/Escape, draft preservation, atomic failure/retry, stale targets, page-only selection, and mobile controls.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
