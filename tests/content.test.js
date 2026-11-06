import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { initialState } from '../src/model.js';

const source = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');

function setup() {
  const connections = [];
  const requests = [];
  const timers = [];
  let getState;
  runInNewContext(source, {
    chrome: { runtime: {
      id: 'test-extension',
      connect() {
        const connection = {
          onMessage: { addListener(fn) { connection.message = fn; } },
          onDisconnect: { addListener(fn) { connection.disconnect = fn; } }
        };
        connections.push(connection);
        return connection;
      },
      sendMessage() { return new Promise(resolve => requests.push(data => resolve({ ok: true, data }))); }
    } },
    GitHubTaskTrackerFilter: { create(options) { getState = options.getState; return { sync() {} }; } },
    GitHubTaskTrackerLabelOrder: { styles: '' },
    GitHubTaskTrackerLabelPicker: { styles: '' },
    location: { pathname: '/' },
    document: { documentElement: {}, addEventListener() {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    setTimeout(fn) { timers.push(fn); },
    console
  });
  return { connections, requests, timers, getState: () => getState() };
}

test('content initialization accepts a snapshot but never overwrites a newer broadcast', async () => {
  const client = setup();
  const older = initialState();
  const newer = { ...older, notes: { 'a/b#1': 'Latest note' } };
  client.connections[0].message(newer);
  client.requests[0](older);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.getState(), newer);

  const fresh = setup();
  fresh.requests[0](older);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fresh.getState(), older);
  fresh.connections[0].message(newer);
  assert.deepEqual(fresh.getState(), newer);
});

test('disconnected content connections cannot overwrite state during reconnection', async () => {
  const client = setup();
  const older = initialState();
  client.connections[0].disconnect();
  client.requests[0](older);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.getState(), undefined);
  client.timers.shift()();
  const newer = { ...older, notes: { 'a/b#1': 'Reconnected' } };
  client.requests[1](newer);
  await new Promise(resolve => setImmediate(resolve));
  client.connections[0].message(older);
  assert.deepEqual(client.getState(), newer);
});
