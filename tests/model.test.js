import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, validateState, applyOperation, normalizeKey, trackedPRKeys } from '../src/model.js';

test('PR identity includes repository and ignores GitHub name casing', () => {
  const state = applyOperation(initialState(), { type: 'setLabel', key: 'PingCAP/docs#42', labelId: 'pending-self', selected: true });
  assert.deepEqual(state.pullRequests['pingcap/docs#42'], ['pending-self']);
  assert.equal(state.pullRequests['pingcap/docs-cn#42'], undefined);
});

test('multiple selections, deselection, and immutable updates', () => {
  const before = initialState();
  let state = applyOperation(before, { type: 'setLabel', key: 'a/b#1', labelId: 'pending-self', selected: true });
  state = applyOperation(state, { type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: true });
  assert.deepEqual(state.pullRequests['a/b#1'], ['pending-self', 'wait-review']);
  state = applyOperation(state, { type: 'setLabel', key: 'a/b#1', labelId: 'pending-self', selected: false });
  assert.deepEqual(state.pullRequests['a/b#1'], ['wait-review']);
  state = applyOperation(state, { type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: false });
  assert.deepEqual(state.pullRequests, {});
  assert.deepEqual(before.pullRequests, {});
});

test('renaming preserves assignments and deleting removes dangling references', () => {
  let state = applyOperation(initialState(), { type: 'setLabel', key: 'a/b#1', labelId: 'pending-self', selected: true });
  state = applyOperation(state, { type: 'saveLabel', label: { id: 'pending-self', name: 'My next action', color: '#123456' } });
  assert.deepEqual(state.pullRequests['a/b#1'], ['pending-self']);
  assert.equal(state.labels[1].name, 'My next action');
  state = applyOperation(state, { type: 'deleteLabel', labelId: 'pending-self' });
  assert.deepEqual(state.pullRequests, {});
  assert.equal(state.labels.length, 3);
});

test('export/import round trip and future formats are rejected', () => {
  const state = initialState();
  assert.deepEqual(validateState(JSON.parse(JSON.stringify({ ...state, exportedAt: '2026-11-03' }))), state);
  assert.throws(() => validateState({ ...state, version: 2 }), /Unsupported/);
});

test('the original self label upgrades without changing assignments or custom names', () => {
  const legacy = initialState();
  legacy.labels.find(label => label.id === 'pending-self').name = 'Pending by myself';
  legacy.pullRequests['a/b#1'] = ['pending-self'];
  const upgraded = validateState(legacy);
  assert.equal(upgraded.labels.find(label => label.id === 'pending-self').name, 'Pending by me');
  assert.deepEqual(upgraded.pullRequests, legacy.pullRequests);
  legacy.labels.find(label => label.id === 'pending-self').name = 'My next action';
  assert.equal(validateState(legacy).labels.find(label => label.id === 'pending-self').name, 'My next action');
  legacy.labels.find(label => label.id === 'pending-self').name = 'Pending by myself';
  legacy.labels.push({ id: 'custom-me', name: 'Pending by me', color: '#123456' });
  assert.equal(validateState(legacy).labels.find(label => label.id === 'pending-self').name, 'Pending by myself');
});

test('malformed and malicious backup values cannot become identifiers or styles', () => {
  for (const key of ['__proto__', 'a/b#0', 'a/b#1/../../x', 'https://github.com/a/b#1']) {
    assert.throws(() => validateState({ ...initialState(), pullRequests: { [key]: [] } }), /identifier/);
  }
  assert.throws(() => validateState({ ...initialState(), pullRequests: { 'a/b#1': ['missing'] } }), /unknown label/);
  assert.throws(() => validateState({ ...initialState(), pullRequests: [] }), /Invalid pull request/);
  assert.throws(() => applyOperation(initialState(), { type: 'saveLabel', label: { id: 'x', name: 'a', color: 'red;display:none' } }), /color/);
  assert.throws(() => applyOperation(initialState(), { type: 'saveLabel', label: { id: 'x', name: ' ', color: '#000000' } }), /1–60/);
});

test('duplicate IDs, names, normalized keys and excessive data are rejected', () => {
  const state = initialState();
  assert.throws(() => validateState({ ...state, labels: [...state.labels, state.labels[0]] }), /Duplicate label/);
  assert.throws(() => applyOperation(state, { type: 'saveLabel', label: { id: 'new', name: 'WAIT FOR REVIEW', color: '#000000' } }), /already exists/);
  assert.throws(() => validateState({ ...state, pullRequests: { 'A/b#1': [], 'a/b#1': [] } }), /Duplicate pull/);
  assert.throws(() => validateState({ ...state, labels: Array(101).fill(state.labels[0]) }), /100 labels/);
});

test('settings rename rejects another label name but allows a case-only rename of itself', () => {
  const before = initialState();
  const snapshot = structuredClone(before);
  assert.throws(() => applyOperation(before, { type: 'saveLabel', label: { id: 'pending-self', name: ' WAIT FOR REVIEW ', color: '#123456' } }), /already exists.*different name/);
  assert.deepEqual(before, snapshot);
  const renamed = applyOperation(before, { type: 'saveLabel', label: { id: 'pending-self', name: ' PENDING BY ME ', color: '#123456' } });
  assert.equal(renamed.labels.find(label => label.id === 'pending-self').name, 'PENDING BY ME');
});

test('a stale editor cannot reassign a deleted label', () => {
  const state = applyOperation(initialState(), { type: 'deleteLabel', labelId: 'pending-self' });
  assert.throws(() => applyOperation(state, { type: 'setLabel', key: 'a/b#1', labelId: 'pending-self', selected: true }), /removed/);
});

test('inline creation assigns the new label and preserves existing selections', () => {
  const before = applyOperation(initialState(), { type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: true });
  const label = { id: 'designer', name: 'Pending by designer', color: '#facc15' };
  const state = applyOperation(before, { type: 'createAndAssignLabel', key: 'A/B#1', label });
  assert.deepEqual(state.labels.at(-1), label);
  assert.deepEqual(state.pullRequests['a/b#1'], ['wait-review', 'designer']);
  assert.equal(before.labels.length, 4);
  assert.deepEqual(before.pullRequests['a/b#1'], ['wait-review']);
});

test('failed inline creation leaves definitions and assignments untouched', () => {
  const state = initialState();
  const snapshot = structuredClone(state);
  for (const label of [
    { id: 'pending-self', name: 'Another name', color: '#123456' },
    { id: 'new', name: ' WAIT FOR REVIEW ', color: '#123456' },
    { id: 'new', name: ' ', color: '#123456' }
  ]) assert.throws(() => applyOperation(state, { type: 'createAndAssignLabel', key: 'a/b#1', label }));
  assert.deepEqual(state, snapshot);
  const full = { version: 1, labels: Array.from({ length: 100 }, (_, index) => ({ id: `label-${index}`, name: `Label ${index}`, color: '#123456' })), pullRequests: {} };
  assert.throws(() => applyOperation(full, { type: 'createAndAssignLabel', key: 'a/b#1', label: { id: 'extra', name: 'Extra', color: '#123456' } }), /100 labels/);
  assert.deepEqual(full.pullRequests, {});
  assert.equal(full.labels.length, 100);
});

test('batch addition unions labels across repositories and creates a shared label atomically', () => {
  const before = initialState();
  before.pullRequests = { 'a/one#1': ['pending-self'], 'b/two#2': ['wait-review'], 'a/one#3': ['pending-engineer'] };
  const snapshot = structuredClone(before);
  const after = applyOperation(before, {
    type: 'addLabelsToPRs', keys: ['A/one#1', 'a/one#1', 'b/two#2'], labelIds: ['pending-engineer', 'wait-review', 'wait-review'],
    newLabel: { id: 'follow', name: 'Follow up today', color: '#123456' }
  });
  assert.deepEqual(after.pullRequests['a/one#1'], ['pending-self', 'pending-engineer', 'wait-review', 'follow']);
  assert.deepEqual(after.pullRequests['b/two#2'], ['wait-review', 'pending-engineer', 'follow']);
  assert.deepEqual(after.pullRequests['a/one#3'], ['pending-engineer']);
  assert.equal(after.labels.at(-1).id, 'follow');
  assert.deepEqual(before, snapshot);
});

test('invalid batches reject all changes, including a new label definition', () => {
  const before = initialState();
  before.pullRequests = { 'a/one#1': ['pending-self'], 'b/two#2': ['wait-review'] };
  const snapshot = structuredClone(before);
  const operation = { type: 'addLabelsToPRs', keys: ['a/one#1', 'b/two#2'], labelIds: ['pending-engineer'] };
  for (const invalid of [
    { keys: [] }, { keys: ['a/one#1', 'a/one#404'] }, { keys: ['a/one#1', 'invalid'] },
    { labelIds: ['missing'] }, { labelIds: [] },
    { newLabel: { id: 'new', name: ' WAIT FOR REVIEW ', color: '#123456' } },
    { newLabel: { id: 'new', name: 'New label', color: 'invalid' } }
  ]) {
    assert.throws(() => applyOperation(before, { ...operation, ...invalid }));
    assert.deepEqual(before, snapshot);
  }
});

test('relative label moves preserve definitions, assignments, and concurrent additions', () => {
  const before = initialState();
  before.pullRequests['a/b#1'] = ['wait-review', 'pending-self'];
  const snapshot = structuredClone(before);
  const moved = applyOperation(before, { type: 'moveLabel', labelId: 'wait-review', targetId: 'pending-engineer', after: true });
  assert.deepEqual(moved.labels.map(label => label.id), ['pending-self', 'pending-engineer', 'wait-review', 'ready-merge']);
  assert.deepEqual(moved.pullRequests, before.pullRequests);
  assert.deepEqual(before, snapshot);
  const added = applyOperation(moved, { type: 'saveLabel', label: { id: 'new', name: 'New label', color: '#123456' } });
  const restored = applyOperation(added, { type: 'moveLabel', labelId: 'wait-review', targetId: 'pending-self', after: false });
  assert.deepEqual(restored.labels.map(label => label.id), [...before.labels.map(label => label.id), 'new']);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(restored))), restored);
  assert.deepEqual(applyOperation(restored, { type: 'moveLabel', labelId: 'wait-review', targetId: 'wait-review', after: true }), restored);
  for (const operation of [
    { labelId: 'missing', targetId: 'pending-self', after: true },
    { labelId: 'wait-review', targetId: 'deleted', after: false },
    { labelId: 'wait-review', targetId: 'pending-self', after: 'false' }
  ]) assert.throws(() => applyOperation(before, { type: 'moveLabel', ...operation }), /removed|position/);
  assert.deepEqual(before, snapshot);
});

test('batch editing adds and removes only explicit labels, preserving other assignments', () => {
  const before = initialState();
  before.pullRequests = { 'a/one#1': ['pending-self', 'wait-review'], 'b/two#2': ['pending-self', 'pending-engineer'], 'c/three#3': ['pending-self'] };
  const snapshot = structuredClone(before);
  const after = applyOperation(before, {
    type: 'updateLabelsOnPRs', keys: ['A/one#1', 'b/two#2'], labelIds: ['ready-merge'], removeLabelIds: ['pending-self'],
    newLabel: { id: 'follow', name: 'Follow up today', color: '#123456' }
  });
  assert.deepEqual(after.pullRequests['a/one#1'], ['wait-review', 'ready-merge', 'follow']);
  assert.deepEqual(after.pullRequests['b/two#2'], ['pending-engineer', 'ready-merge', 'follow']);
  assert.deepEqual(after.pullRequests['c/three#3'], ['pending-self']);
  assert.equal(after.labels.length, before.labels.length + 1);
  assert.deepEqual(before, snapshot);
});

test('removal-only batches untrack empty PRs without deleting definitions or other PR labels', () => {
  const before = initialState();
  before.pullRequests = { 'a/one#1': ['pending-self'], 'b/two#2': ['pending-self', 'wait-review'], 'c/three#3': ['pending-self'] };
  const after = applyOperation(before, { type: 'updateLabelsOnPRs', keys: ['a/one#1', 'b/two#2'], labelIds: [], removeLabelIds: ['pending-self'] });
  assert.equal(Object.hasOwn(after.pullRequests, 'a/one#1'), false);
  assert.deepEqual(after.pullRequests['b/two#2'], ['wait-review']);
  assert.deepEqual(after.pullRequests['c/three#3'], ['pending-self']);
  assert.deepEqual(after.labels, before.labels);
});

test('invalid removals reject the entire batch, including additions and new definitions', () => {
  const before = initialState();
  before.pullRequests = { 'a/one#1': ['pending-self'] };
  const snapshot = structuredClone(before);
  const operation = { type: 'updateLabelsOnPRs', keys: ['a/one#1'], labelIds: ['wait-review'], removeLabelIds: ['pending-self'], newLabel: { id: 'new', name: 'New label', color: '#123456' } };
  for (const invalid of [
    { removeLabelIds: ['deleted'] }, { removeLabelIds: 'pending-self' }, { removeLabelIds: null },
    { removeLabelIds: ['wait-review'] }, { keys: ['a/one#1', 'b/two#404'] },
    { newLabel: { id: 'new', name: 'WAIT FOR REVIEW', color: '#123456' } },
    { labelIds: [], removeLabelIds: [], newLabel: undefined }
  ]) {
    assert.throws(() => applyOperation(before, { ...operation, ...invalid }));
    assert.deepEqual(before, snapshot);
  }
});

test('private notes migrate from old backups and round-trip as plain text', () => {
  const legacy = { version: 1, labels: initialState().labels, pullRequests: { 'a/one#1': ['pending-self'] } };
  const before = validateState(legacy);
  assert.deepEqual(before.notes, {});
  const text = '  Check with engineer\n<img src=x onerror=alert(1)>\n下周再看';
  const after = applyOperation(before, { type: 'setNote', key: 'A/one#1', text, expectedText: '' });
  assert.equal(after.notes['a/one#1'], text);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(after))), after);
  assert.deepEqual(before.notes, {});
  assert.deepEqual(after.pullRequests, before.pullRequests);
});

test('only labeled PRs are tracked while notes survive removal and relabeling', () => {
  let state = initialState();
  state.pullRequests['a/one#1'] = ['pending-self', 'wait-review'];
  state = applyOperation(state, { type: 'setNote', key: 'a/one#1', text: 'Saved for later', expectedText: '' });
  state = applyOperation(state, { type: 'setLabel', key: 'a/one#1', labelId: 'pending-self', selected: false });
  assert.deepEqual(trackedPRKeys(state), ['a/one#1']);
  state = applyOperation(state, { type: 'setLabel', key: 'a/one#1', labelId: 'wait-review', selected: false });
  assert.deepEqual(trackedPRKeys(state), []);
  assert.equal(state.notes['a/one#1'], 'Saved for later');
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
  const snapshot = structuredClone(state);
  for (const type of ['addLabelsToPRs', 'updateLabelsOnPRs']) {
    assert.throws(() => applyOperation(state, { type, keys: ['a/one#1'], labelIds: ['wait-review'] }), /no longer tracked/);
  }
  assert.throws(() => applyOperation(state, { type: 'setNote', key: 'a/one#1', text: 'Stale draft', expectedText: 'Saved for later' }), /no longer tracked/);
  assert.deepEqual(state, snapshot);
  state = applyOperation(state, { type: 'setLabel', key: 'a/one#1', labelId: 'wait-review', selected: true });
  assert.deepEqual(trackedPRKeys(state), ['a/one#1']);
  assert.equal(state.notes['a/one#1'], 'Saved for later');
  state = applyOperation(state, { type: 'updateLabelsOnPRs', keys: ['a/one#1'], labelIds: [], removeLabelIds: ['wait-review'] });
  assert.deepEqual(trackedPRKeys(state), []);
  assert.equal(state.notes['a/one#1'], 'Saved for later');
  state = applyOperation(state, { type: 'setLabel', key: 'a/one#1', labelId: 'wait-review', selected: true });
  state = applyOperation(state, { type: 'deleteLabel', labelId: 'wait-review' });
  assert.deepEqual(trackedPRKeys(state), []);
  assert.equal(state.notes['a/one#1'], 'Saved for later');
});

test('note conflicts and malformed notes fail atomically', () => {
  const before = initialState();
  before.pullRequests['a/one#1'] = ['pending-self'];
  before.notes['a/one#1'] = 'Newer note';
  const snapshot = structuredClone(before);
  for (const invalid of [
    { key: 'b/other#1', text: 'Orphan', expectedText: '' },
    { key: 'a/one#1', text: 'Overwrite', expectedText: 'Old note' },
    { key: 'a/one#1', text: 'a'.repeat(2001), expectedText: 'Newer note' },
    { key: 'a/one#1', text: {}, expectedText: 'Newer note' }
  ]) {
    assert.throws(() => applyOperation(before, { type: 'setNote', ...invalid }));
    assert.deepEqual(before, snapshot);
  }
  for (const notes of [null, [], 'invalid', { '__proto__#1': 'bad' }, { 'a/one#1': {} }, { 'a/one#1': 'a'.repeat(2001) }, { 'A/one#1': '', 'a/one#1': 'duplicate' }]) {
    assert.throws(() => validateState({ ...before, notes }));
  }
  assert.equal(validateState({ ...before, notes: { 'A/one#1': 'safe' } }).notes['a/one#1'], 'safe');
});

test('dot-prefixed repository names remain valid', () => {
  assert.equal(normalizeKey('GitHub/.github#1'), 'github/.github#1');
  assert.throws(() => normalizeKey('.hidden/repo#1'), /identifier/);
});

test('batch addition rejects removals without changing the input', () => {
  const before = applyOperation(initialState(), { type: 'setLabel', key: 'a/b#1', labelId: 'wait-review', selected: true });
  const snapshot = structuredClone(before);
  const operation = { type: 'addLabelsToPRs', keys: ['a/b#1'], labelIds: ['pending-self'] };
  assert.throws(() => applyOperation(before, { ...operation, removeLabelIds: ['wait-review'] }), /updateLabelsOnPRs/);
  assert.deepEqual(before, snapshot);
  for (const removeLabelIds of [undefined, []]) {
    assert.deepEqual(applyOperation(before, { ...operation, removeLabelIds }).pullRequests['a/b#1'], ['wait-review', 'pending-self']);
  }
});
