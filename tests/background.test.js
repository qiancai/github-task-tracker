import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY } from '../src/model.js';

test('worker serializes tab writes, broadcasts updates, and recovers after rejected operations', async () => {
  let listener;
  let connect;
  let stored = {};
  let access;
  let action;
  const openedTabs = [];
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
      onConnect: { addListener(fn) { connect = fn; } },
      async openOptionsPage() {}
    },
    action: { onClicked: { addListener(fn) { action = fn; } } },
    tabs: { async create(tab) { openedTabs.push(tab); } },
    storage: { local: {
      async setAccessLevel(value) { access = value; },
      async get() { return structuredClone(stored); },
      async set(value) { await new Promise(resolve => setTimeout(resolve, 5)); stored = structuredClone(value); }
    } }
  };
  await import('../src/background.js');
  const updates = [];
  connect({ name: 'github-task-tracker', sender: { id: 'test-extension' }, postMessage: value => updates.push(value), onDisconnect: { addListener() {} } });
  const send = operation => new Promise(resolve => listener({ scope: 'github-task-tracker', ...operation }, { id: 'test-extension' }, resolve));
  assert.equal((await send({ type: 'get' })).data.labels.length, 4);
  assert.deepEqual(access, { accessLevel: 'TRUSTED_CONTEXTS' });
  const results = await Promise.all([
    send({ type: 'setLabel', key: 'a/b#1', labelId: 'pending-self', selected: true }),
    send({ type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: true }),
    send({ type: 'setLabel', key: 'a/b#2', labelId: 'pending-engineer', selected: true })
  ]);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(stored[STORAGE_KEY].pullRequests['a/b#1'], ['pending-self', 'wait-review']);
  assert.deepEqual(stored[STORAGE_KEY].pullRequests['a/b#2'], ['pending-engineer']);
  assert.equal(updates.length, 3);
  const snapshot = structuredClone(stored);
  assert.equal((await send({ type: 'addLabelsToPRs', keys: ['a/b#1', 'a/b#404'], labelIds: ['pending-engineer'], newLabel: { id: 'batch-new', name: 'Batch new', color: '#123456' } })).ok, false);
  assert.deepEqual(stored, snapshot, 'Failed batch changed persistent data');
  assert.equal((await send({ type: 'updateLabelsOnPRs', keys: ['a/b#1', 'a/b#404'], labelIds: ['ready-merge'], removeLabelIds: ['pending-self'] })).ok, false);
  assert.deepEqual(stored, snapshot, 'Failed mixed batch changed persistent data');
  assert.equal((await send({ type: 'replace', state: { version: 999 } })).ok, false);
  assert.deepEqual(stored, snapshot);
  assert.equal((await send({ type: 'get' })).ok, true);
  const replied = listener({ scope: 'github-task-tracker', type: 'get' }, { id: 'other-extension' }, () => assert.fail('Untrusted sender received a response'));
  assert.equal(replied, undefined);
  assert.equal((await send({ type: 'openTasks' })).ok, true);
  await action();
  assert.deepEqual(openedTabs, [{ url: 'chrome-extension://test-extension/tasks.html' }, { url: 'chrome-extension://test-extension/tasks.html' }]);
});

test('storage initialization failures are reported, block data access, and can be retried', async () => {
  let listener;
  let attempts = 0;
  let reads = 0;
  let settingsOpened = 0;
  let stored = {};
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener(fn) { listener = fn; } },
      onConnect: { addListener() {} },
      async openOptionsPage() { settingsOpened++; }
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: {
      async setAccessLevel() {
        attempts++;
        if (attempts <= 2) throw new Error('Temporary API failure');
      },
      async get() { reads++; return structuredClone(stored); },
      async set(value) { stored = structuredClone(value); }
    } }
  };
  await import('../src/background.js?access-retry');
  const send = operation => new Promise(resolve => listener({ scope: 'github-task-tracker', ...operation }, { id: 'test-extension' }, resolve));
  assert.equal(attempts, 0);
  assert.equal((await send({ type: 'openSettings' })).ok, true);
  assert.equal(settingsOpened, 1);
  assert.equal(attempts, 0);
  for (let index = 0; index < 2; index++) {
    const failure = await send({ type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: true });
    assert.equal(failure.ok, false);
    assert.match(failure.error, /initialize private storage.*Try again.*Temporary API failure/);
    assert.equal(reads, 0);
    assert.deepEqual(stored, {});
  }
  const recovered = await send({ type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: true });
  assert.equal(recovered.ok, true);
  assert.deepEqual(stored[STORAGE_KEY].pullRequests['a/b#1'], ['wait-review']);
  await send({ type: 'get' });
  assert.equal(attempts, 3, 'Successful initialization should be cached');
});
