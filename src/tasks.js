import './label-order.js';
import './label-picker.js';
import { loadPRMetadata } from './pr-metadata.js';
import { trackedPRKeys } from './model.js';

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 25;
const CACHE_MS = 5 * 60 * 1000;
const SESSION_CACHE = 'githubTaskTrackerDetails';
const cache = restoreCache();

function restoreCache() {
  try {
    const entries = JSON.parse(sessionStorage.getItem(SESSION_CACHE) || '[]');
    if (!Array.isArray(entries) || entries.length > 500) return new Map();
    return new Map(entries.filter(entry => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [key, value] = entry;
      const data = value?.data;
      return typeof key === 'string' && /^[\w-]+\/[\w.-]+#[1-9]\d{0,9}$/.test(key)
        && Number.isFinite(value?.time) && value.time >= 0 && value.time <= Date.now()
        && (!value.error || (typeof value.error === 'string' && value.error.length <= 1500))
        && data && typeof data.title === 'string' && data.title.length <= 500
        && typeof data.author === 'string' && data.author.length <= 100
        && typeof data.base === 'string' && data.base.length <= 255
        && ['open', 'closed', 'merged', 'draft', 'unknown'].includes(data.state);
    }));
  } catch { return new Map(); }
}

function persistCache() {
  if (!state) return;
  try {
    // Keep this tab's latest details across reload/discard recovery without storing label assignments.
    const tracked = new Set(trackedPRKeys(state));
    const visible = new Set(visibleKeys);
    const entries = [...cache].filter(([key, entry]) => tracked.has(key) && entry.data)
      .sort(([a, left], [b, right]) => Number(visible.has(b)) - Number(visible.has(a)) || right.time - left.time)
      .slice(0, 500);
    sessionStorage.setItem(SESSION_CACHE, JSON.stringify(entries));
  } catch { /* Storage can be unavailable or full; the in-memory list still works. */ }
}

function expireDetails(keys) {
  for (const key of keys) if (cache.has(key)) cache.get(key).time = 0;
}
const removing = new Set();
const selectedKeys = new Set();
const dialogChanges = new Map();
let selectionScope;
let targetKeys = [];
let applying = false;
let state;
let page = 1;
let visibleKeys = [];
let generation = 0;
let controller;
const sortFields = ['title', 'author', 'base'];
const SORT_PREFERENCE = 'githubTaskTrackerTaskSort';
let preferredSort = readPreferredSort();
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function readPreferredSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_PREFERENCE));
    if (saved && (saved.field === '' || sortFields.includes(saved.field)) && typeof saved.descending === 'boolean') return saved;
  } catch { /* Fall back to title ascending when preferences are unavailable or invalid. */ }
  return { field: 'title', descending: false };
}

function readSort() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const field = hash.get('sort');
  if (sortFields.includes(field) || field === 'repository') return { field: field === 'repository' ? '' : field, descending: hash.get('direction') === 'desc' };
  return preferredSort;
}

function changeSort(field, descending = false) {
  const hash = new URLSearchParams(location.hash.slice(1));
  preferredSort = { field, descending: Boolean(field && descending) };
  try { localStorage.setItem(SORT_PREFERENCE, JSON.stringify(preferredSort)); } catch { /* URL sorting still works if local preferences cannot be saved. */ }
  hash.set('sort', field || 'repository');
  hash.set('direction', preferredSort.descending ? 'desc' : 'asc');
  history.replaceState({}, '', `${location.pathname}${hash.size ? '#' + hash : ''}`);
  page = 1;
  render();
}

function defaultOrder(a, b) {
  return a.split('#')[0].localeCompare(b.split('#')[0]) || Number(b.split('#')[1]) - Number(a.split('#')[1]);
}

function fresh(key) {
  return cache.has(key) && Date.now() - cache.get(key).time < CACHE_MS;
}

const orderStyle = document.createElement('style');
orderStyle.textContent = globalThis.GitHubTaskTrackerLabelOrder.styles + globalThis.GitHubTaskTrackerLabelPicker.styles;
document.head.append(orderStyle);
const labelOrder = globalThis.GitHubTaskTrackerLabelOrder.create($('#add-label-choices'), {
  move: async operation => { state = await request(operation); render(); },
  error: message => { $('#add-labels-error').textContent = message; },
  disabled: () => applying
});

async function request(operation) {
  const result = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', ...operation });
  if (!result?.ok) throw new Error(result?.error || 'Extension unavailable. Reload this page and try again.');
  return result.data;
}

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = error ? 'error' : '';
}

function setOptions(select, entries, selected, all) {
  const options = [new Option(all, ''), ...entries.map(([value, name]) => new Option(name, value))];
  // Preserve keyboard focus and selection when another GitHub tab changes an assignment.
  if (JSON.stringify([...select.options].map(item => [item.value, item.text])) !== JSON.stringify(options.map(item => [item.value, item.text]))) select.replaceChildren(...options);
  if (selected && !entries.some(([value]) => value === selected)) select.append(new Option('Unavailable selection', selected));
  select.value = selected;
}

function readFilters() {
  const hash = new URLSearchParams(location.hash.slice(1));
  return { label: hash.get('label') || '', repository: hash.get('repository') || '' };
}

function writeFilters() {
  const hash = new URLSearchParams(location.hash.slice(1));
  hash.delete('label'); hash.delete('repository');
  if ($('#label-filter').value) hash.set('label', $('#label-filter').value);
  if ($('#repo-filter').value) hash.set('repository', $('#repo-filter').value);
  history.replaceState({}, '', `${location.pathname}${hash.size ? '#' + hash : ''}`);
  page = 1;
  render();
}

function render(prepared = false) {
  if (!state) return;
  controller?.abort();
  controller = new AbortController();
  const run = ++generation;
  const filters = readFilters();
  const sort = readSort();
  $('#sort-field').value = sort.field;
  $('#sort-direction').disabled = !sort.field;
  $('#sort-direction').textContent = sort.descending ? '↓ Descending' : '↑ Ascending';
  for (const button of document.querySelectorAll('[data-sort]')) {
    const active = button.dataset.sort === sort.field;
    button.parentElement.setAttribute('aria-sort', active ? (sort.descending ? 'descending' : 'ascending') : 'none');
    button.querySelector('span').textContent = active ? (sort.descending ? ' ↓' : ' ↑') : ' ↕';
  }
  const allKeys = trackedPRKeys(state);
  const repositories = [...new Set(allKeys.map(key => key.split('#')[0]))].sort();
  setOptions($('#label-filter'), state.labels.map(label => [label.id, label.name]), filters.label, 'All labels');
  setOptions($('#repo-filter'), repositories.map(repository => [repository, repository]), filters.repository, 'All repositories');
  const keys = allKeys.filter(key => (!filters.label || (state.pullRequests[key] || []).includes(filters.label)) && (!filters.repository || key.split('#')[0] === filters.repository))
    .sort(defaultOrder);
  // Show cached rows immediately; refresh every matching PR before finalizing a metadata sort.
  const refreshingSort = sort.field && !prepared && keys.some(key => !fresh(key));
  if (sort.field) keys.sort((a, b) => {
    const left = cache.get(a)?.data?.[sort.field];
    const right = cache.get(b)?.data?.[sort.field];
    // Missing values remain last in either direction, with deterministic ties.
    if (!left || !right) return left ? -1 : right ? 1 : defaultOrder(a, b);
    return collator.compare(left, right) * (sort.descending ? -1 : 1) || defaultOrder(a, b);
  });
  const pages = Math.max(1, Math.ceil(keys.length / PAGE_SIZE));
  page = Math.min(page, pages);
  visibleKeys = keys.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const scope = JSON.stringify([filters, sort, page]);
  if (scope !== selectionScope) selectedKeys.clear();
  selectionScope = scope;
  for (const key of selectedKeys) if (!visibleKeys.includes(key)) selectedKeys.delete(key);
  const repoCount = new Set(keys.map(key => key.split('#')[0])).size;
  $('#task-count').textContent = `${keys.length} PR${keys.length === 1 ? '' : 's'} across ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'}`;
  const fragment = document.createDocumentFragment();
  $('#empty-tasks').hidden = keys.length > 0;
  $('#empty-tasks').textContent = allKeys.length ? 'No tasks match these filters. Clear filters to see all labeled PRs.' : 'No tracked PRs yet. Add a private label to a PR on GitHub to start tracking it here.';
  $('#task-pagination').hidden = pages <= 1;
  $('#page-count').textContent = `Page ${page} of ${pages}`;
  $('#previous-page').disabled = page === 1;
  $('#next-page').disabled = page === pages;
  const rows = new Map();
  for (const key of visibleKeys) {
    const [repository, number] = key.split('#');
    const row = node('tr');
    row.dataset.key = key;
    row.dataset.selected = String(selectedKeys.has(key));
    const selection = node('td', '', 'task-select-cell');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.setAttribute('aria-label', `Select ${key}`);
    checkbox.checked = selectedKeys.has(key);
    checkbox.disabled = applying;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedKeys.add(key); else selectedKeys.delete(key);
      updateSelection();
    });
    selection.append(checkbox);
    const pr = node('td', '', 'task-pr-cell');
    const title = node('a', `PR #${number}`, 'task-title');
    title.href = `https://github.com/${repository}/pull/${number}`;
    title.target = '_blank'; title.rel = 'noreferrer';
    const heading = node('div', '', 'task-heading');
    const status = node('span', 'Loading', 'task-state');
    const files = node('a', 'Files', 'task-files');
    files.href = `${title.href}/files`;
    files.target = '_blank'; files.rel = 'noreferrer';
    files.title = `View changed files for ${key}`;
    files.setAttribute('aria-label', files.title);
    const reference = node('span', '', 'task-reference');
    reference.append(node('span', repository, 'task-repository'), node('span', `#${number}`, 'task-number'), status);
    heading.append(files, ' ', title, ' ', reference);
    const error = node('p', '', 'task-error');
    const retry = node('button', 'Retry details', 'task-retry');
    retry.type = 'button'; retry.hidden = true;
    retry.addEventListener('click', () => { expireDetails([key]); render(); });
    pr.append(heading, error, retry);
    const author = node('td', '', 'task-author-cell'); author.dataset.heading = 'Author';
    const authorName = node('span', 'Loading…', 'author-name'); author.append(authorName);
    const base = node('td', '', 'task-base-cell'); base.dataset.heading = 'Base branch';
    const baseName = node('span', 'Loading…', 'base-name'); base.append(baseName);
    const labels = node('td', '', 'task-labels-cell'); labels.dataset.heading = 'Private labels';
    const tags = node('div', '', 'task-labels');
    for (const label of state.labels) {
      if ((state.pullRequests[key] || []).includes(label.id)) tags.append(tag(key, label));
    }
    const add = node('button', '', 'task-add-label');
    add.append(globalThis.GitHubTaskTrackerLabelPicker.plusIcon());
    add.type = 'button';
    add.setAttribute('aria-haspopup', 'dialog');
    add.setAttribute('aria-controls', 'add-labels-dialog');
    add.setAttribute('aria-expanded', 'false');
    add.setAttribute('aria-label', `Edit private labels for ${key}`);
    add.title = 'Edit private labels';
    add.disabled = applying;
    add.addEventListener('click', () => openLabelDialog([key], add));
    tags.append(add);
    labels.append(tags);
    const notes = node('td', '', 'task-notes-cell'); notes.dataset.heading = 'Notes';
    const text = state.notes[key] || '';
    const note = node('button', text || 'Add note', 'task-note');
    note.type = 'button';
    note.dataset.empty = String(!text);
    note.title = text || 'Add a private note';
    note.setAttribute('aria-label', `${text ? 'Edit' : 'Add'} note for ${key}`);
    note.addEventListener('click', () => openNoteEditor(key));
    notes.append(note);
    row.append(selection, pr, author, base, labels, notes);
    fragment.append(row);
    const elements = { title, status, authorName, baseName, error, retry, number };
    rows.set(key, elements);
    if (cache.has(key)) updateRow(elements, cache.get(key));
  }
  $('#task-rows').replaceChildren(fragment);
  updateSelection();
  if ($('#add-labels-dialog').open && !applying) renderLabelChoices();
  if ($('#note-dialog').open && !savingNote) updateNoteEditor();
  $('#task-results').setAttribute('aria-busy', 'true');
  const reuse = Boolean(sort.field) && !refreshingSort;
  const pendingKeys = (refreshingSort ? keys : visibleKeys).filter(key => !cache.has(key) || (!reuse && !fresh(key)));
  showRefreshProgress(0, pendingKeys.length);
  void loadRows(pendingKeys, rows, run, controller, done => showRefreshProgress(done, pendingKeys.length)).then(() => {
    if (run !== generation) return;
    persistCache();
    if (refreshingSort) render(true);
    else { $('#task-results').setAttribute('aria-busy', 'false'); showRefreshProgress(0, 0); }
  });
}

function showRefreshProgress(done, total) {
  const busy = total > 0;
  const button = $('#refresh-details');
  button.disabled = busy;
  button.dataset.loading = String(busy);
  button.setAttribute('aria-busy', String(busy));
  button.title = busy ? 'Refreshing PR details…' : 'Refresh details';
  $('#refresh-status').hidden = !busy;
  $('#sort-progress').textContent = busy ? `Refreshing ${done} / ${total} PRs…` : '';
  $('#refresh-progress').max = Math.max(1, total);
  $('#refresh-progress').value = done;
  positionRefreshStatus();
}

function positionRefreshStatus() {
  const status = $('#refresh-status');
  if (status.hidden) return;
  const rect = $('#refresh-details').getBoundingClientRect();
  globalThis.GitHubTaskTrackerLabelPicker.place(status, { left: rect.right - status.offsetWidth, top: rect.top, bottom: rect.bottom });
}
window.addEventListener('resize', positionRefreshStatus);
window.addEventListener('scroll', positionRefreshStatus, true);

let noteKey;
let noteOriginal = '';
let savingNote = false;

function openNoteEditor(key) {
  if (savingNote || $('#note-dialog').open) return;
  noteKey = key;
  noteOriginal = state.notes[key] || '';
  $('#note-target').textContent = key;
  $('#note-text').value = noteOriginal;
  $('#note-error').textContent = '';
  updateNoteEditor();
  $('#note-dialog').showModal();
  $('#note-text').focus();
}

function updateNoteEditor() {
  const tracked = trackedPRKeys(state).includes(noteKey);
  const changed = (state.notes[noteKey] || '') !== noteOriginal;
  $('#note-conflict').textContent = !tracked ? 'This PR is no longer tracked. Close the note editor.' : changed ? 'This note changed in another tab. Copy any draft you need before loading the latest note.' : '';
  $('#reload-note').hidden = !tracked || !changed || savingNote;
  $('#save-note').disabled = savingNote || !tracked || changed || $('#note-text').value === noteOriginal;
  $('#cancel-note').disabled = savingNote;
  $('#note-text').disabled = savingNote;
}

$('#note-text').addEventListener('input', updateNoteEditor);
$('#cancel-note').addEventListener('click', () => $('#note-dialog').close());
$('#reload-note').addEventListener('click', () => {
  noteOriginal = state.notes[noteKey] || '';
  $('#note-text').value = noteOriginal;
  $('#note-error').textContent = '';
  updateNoteEditor();
});
$('#note-dialog').addEventListener('cancel', event => { if (savingNote) event.preventDefault(); });
$('#note-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (savingNote || $('#save-note').disabled) return;
  savingNote = true;
  $('#note-error').textContent = '';
  updateNoteEditor();
  try {
    state = await request({ type: 'setNote', key: noteKey, text: $('#note-text').value, expectedText: noteOriginal });
    $('#note-dialog').close();
    render();
    notify('');
  } catch (error) { $('#note-error').textContent = error.message; }
  finally { savingNote = false; updateNoteEditor(); }
});

function updateSelection() {
  $('#bulk-actions').hidden = !visibleKeys.length;
  $('#selected-count').textContent = `${selectedKeys.size} selected on this page`;
  $('.task-table').dataset.hasSelection = String(selectedKeys.size > 0);
  $('#private-labels-heading').hidden = selectedKeys.size > 0;
  $('#bulk-add-labels').hidden = !selectedKeys.size;
  $('#bulk-add-labels').disabled = !selectedKeys.size || applying;
  for (const selector of ['#select-all', '#select-page']) {
    $(selector).checked = visibleKeys.length > 0 && selectedKeys.size === visibleKeys.length;
    $(selector).indeterminate = selectedKeys.size > 0 && selectedKeys.size < visibleKeys.length;
    $(selector).disabled = !visibleKeys.length || applying;
  }
  for (const row of document.querySelectorAll('#task-rows tr')) {
    row.dataset.selected = String(selectedKeys.has(row.dataset.key));
    row.querySelector('.task-checkbox').checked = selectedKeys.has(row.dataset.key);
  }
}

let labelAnchor;
let labelRestoreFocus = true;
function openLabelDialog(keys, anchor) {
  if (applying) return;
  const panel = $('#add-labels-dialog');
  if (panel.open) {
    panel.close();
    if (JSON.stringify(targetKeys) === JSON.stringify(keys) && anchor === currentLabelTrigger()) return;
  }
  labelRestoreFocus = true;
  targetKeys = [...keys];
  dialogChanges.clear();
  labelAnchor = { key: anchor.classList.contains('task-add-label') ? keys[0] : null, rect: anchor.getBoundingClientRect() };
  $('#add-labels-form').reset();
  $('#new-task-label').hidden = true;
  $('#create-label-toggle').hidden = false;
  $('#create-label-toggle').setAttribute('aria-expanded', 'false');
  $('#add-labels-error').textContent = '';
  $('#add-labels-title').textContent = `My private labels${keys.length === 1 ? '' : ' · ' + keys.length + ' PRs'}`;
  $('#add-labels-target').textContent = keys.length === 1 ? keys[0] : `${keys.length} selected PRs. This selection is fixed until you close the dialog.`;
  renderLabelChoices();
  panel.style.top = '12px'; panel.style.left = '12px';
  panel.show();
  placeLabelPanel();
}

function updateApplyButton() {
  $('#apply-add-labels').disabled = applying || (!dialogChanges.size && !$('#add-label-name').value.trim());
  $('#cancel-add-labels').disabled = applying;
  $('#add-label-name').disabled = applying;
  $('#add-label-color').disabled = applying;
  $('#cancel-create-label').disabled = applying;
  $('#create-label-toggle').disabled = applying;
}

function renderLabelChoices() {
  for (const id of dialogChanges.keys()) if (!state.labels.some(label => label.id === id)) dialogChanges.delete(id);
  $('#add-label-choices').replaceChildren();
  for (const label of state.labels) {
    const count = targetKeys.filter(key => state.pullRequests[key]?.includes(label.id)).length;
    const row = node('label');
    const input = node('input');
    input.type = 'checkbox';
    input.value = label.id;
    input.checked = dialogChanges.has(label.id) ? dialogChanges.get(label.id) : count === targetKeys.length;
    input.disabled = applying;
    input.indeterminate = count > 0 && count < targetKeys.length && !dialogChanges.has(label.id);
    input.addEventListener('change', () => {
      dialogChanges.set(label.id, input.checked);
      updateCoverage();
      updateApplyButton();
    });
    const coverage = node('small');
    function updateCoverage() {
      const action = dialogChanges.has(label.id) ? (dialogChanges.get(label.id) ? 'add to all' : 'remove from all') : '';
      coverage.textContent = `${count}/${targetKeys.length}${action ? (dialogChanges.get(label.id) ? ' +' : ' −') : ''}`;
      coverage.title = `${count}/${targetKeys.length} PRs${action ? ' · ' + action : ''}`;
      coverage.setAttribute('aria-label', coverage.title);
      coverage.hidden = targetKeys.length === 1;
    }
    updateCoverage();
    const colorLabel = node('span', label.name, 'choice-name picker-label');
    globalThis.GitHubTaskTrackerLabelPicker.colorize(colorLabel, label);
    row.append(labelOrder.handle(row, label), input, colorLabel, coverage);
    $('#add-label-choices').append(row);
  }
  updateApplyButton();
  placeLabelPanel();
}

function currentLabelTrigger() {
  if (!labelAnchor) return null;
  return labelAnchor.key
    ? [...document.querySelectorAll('#task-rows tr')].find(row => row.dataset.key === labelAnchor.key)?.querySelector('.task-add-label')
    : $('#bulk-add-labels');
}

function placeLabelPanel() {
  const panel = $('#add-labels-dialog');
  if (!panel.open || !labelAnchor) return;
  // Broadcasts may replace the trigger while the editor is open. Keep its latest position.
  const current = currentLabelTrigger();
  document.querySelectorAll('.task-add-label,#bulk-add-labels').forEach(button => button.setAttribute('aria-expanded', String(button === current)));
  if (current?.isConnected && current.getClientRects().length) labelAnchor.rect = current.getBoundingClientRect();
  globalThis.GitHubTaskTrackerLabelPicker.place(panel, labelAnchor.rect);
}

new ResizeObserver(placeLabelPanel).observe($('#add-labels-dialog'));
window.addEventListener('resize', placeLabelPanel);
window.addEventListener('scroll', placeLabelPanel, true);
document.addEventListener('pointerdown', event => {
  const panel = $('#add-labels-dialog');
  if (panel.open && !applying && !panel.contains(event.target) && !event.target.closest('.task-add-label,#bulk-add-labels')) { labelRestoreFocus = false; panel.close(); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#add-labels-dialog').open && !$('#note-dialog').open) {
    event.preventDefault();
    if (!applying) $('#add-labels-dialog').close();
  }
});
$('#add-labels-dialog').addEventListener('close', () => {
  if (!$('#add-labels-dialog').open) document.querySelectorAll('.task-add-label,#bulk-add-labels').forEach(button => button.setAttribute('aria-expanded', 'false'));
  if (!$('#add-labels-dialog').open && labelRestoreFocus) currentLabelTrigger()?.focus({ preventScroll: true });
});
$('#create-label-toggle').addEventListener('click', () => {
  $('#new-task-label').hidden = false;
  $('#create-label-toggle').hidden = true;
  $('#create-label-toggle').setAttribute('aria-expanded', 'true');
  placeLabelPanel();
  $('#add-label-name').focus();
});
$('#cancel-create-label').addEventListener('click', () => {
  $('#new-task-label').hidden = true;
  $('#add-label-name').value = '';
  $('#create-label-toggle').hidden = false;
  $('#create-label-toggle').setAttribute('aria-expanded', 'false');
  updateApplyButton(); placeLabelPanel();
});

$('#add-label-name').addEventListener('input', updateApplyButton);
$('#cancel-add-labels').addEventListener('click', () => $('#add-labels-dialog').close());
$('#add-labels-dialog').addEventListener('cancel', event => { if (applying) event.preventDefault(); });
$('#add-labels-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (applying || $('#apply-add-labels').disabled) return;
  const name = $('#add-label-name').value.trim();
  const operation = {
    type: 'updateLabelsOnPRs', keys: [...targetKeys],
    labelIds: [...dialogChanges].filter(([, selected]) => selected).map(([id]) => id),
    removeLabelIds: [...dialogChanges].filter(([, selected]) => !selected).map(([id]) => id)
  };
  if (name) operation.newLabel = { id: crypto.randomUUID(), name, color: $('#add-label-color').value };
  applying = true;
  $('#add-labels-error').textContent = '';
  updateApplyButton();
  $('#add-label-choices').querySelectorAll('input').forEach(input => { input.disabled = true; });
  try {
    state = await request(operation);
    selectedKeys.clear();
    $('#add-labels-dialog').close();
    render();
    notify('');
  } catch (error) { $('#add-labels-error').textContent = error.message; }
  finally {
    applying = false;
    updateApplyButton();
    updateSelection();
    // Broadcasts can rebuild rows while saving; enable the current controls, not detached ones.
    document.querySelectorAll('.task-checkbox,.task-add-label').forEach(input => { input.disabled = false; });
    document.querySelectorAll('button[data-removal]').forEach(button => { button.disabled = removing.has(button.dataset.removal); });
    if ($('#add-labels-dialog').open) renderLabelChoices();
  }
});

for (const selector of ['#select-all', '#select-page']) $(selector).addEventListener('change', event => {
  selectedKeys.clear();
  if (event.target.checked) for (const key of visibleKeys) selectedKeys.add(key);
  updateSelection();
});
$('#bulk-add-labels').addEventListener('click', () => openLabelDialog([...selectedKeys], $('#bulk-add-labels')));

function tag(key, label) {
  const item = node('span', '', 'task-tag');
  globalThis.GitHubTaskTrackerLabelPicker.colorize(item, label);
  const name = node('button', label.name, 'task-label-name');
  name.type = 'button';
  name.title = `Filter by ${label.name}`;
  name.setAttribute('aria-label', name.title);
  name.addEventListener('click', () => {
    $('#label-filter').value = label.id;
    writeFilters();
  });
  const remove = node('button', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${label.name} from ${key}`);
  const operationId = `${key}:${label.id}`;
  remove.dataset.removal = operationId;
  remove.disabled = applying || removing.has(operationId);
  remove.addEventListener('click', async () => {
    if (removing.has(operationId)) return;
    removing.add(operationId); remove.disabled = true;
    try {
      state = await request({ type: 'setLabel', key, labelId: label.id, selected: false });
      render(); notify('');
    } catch (error) { notify(error.message, true); }
    finally {
      removing.delete(operationId); remove.disabled = false;
      for (const button of document.querySelectorAll('button[data-removal]')) {
        if (button.dataset.removal === operationId) button.disabled = false;
      }
    }
  });
  item.append(name, remove);
  return item;
}

function updateRow(row, entry) {
  const data = entry.data;
  row.title.textContent = data?.title || `PR #${row.number}`;
  row.authorName.textContent = data?.author || 'Unavailable';
  row.baseName.textContent = data?.base || 'Unavailable';
  row.status.dataset.state = data?.state || 'unknown';
  row.status.textContent = data ? ({ open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft', unknown: 'Unknown' })[data.state] : 'Unavailable';
  row.error.textContent = entry.error || (data && (!data.author || !data.base) ? 'Some PR details are unavailable. Open the PR to verify them.' : '');
  row.retry.hidden = !row.error.textContent;
}

async function loadRows(keys, rows, run, abort, progress, reuse = false) {
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < keys.length && !abort.signal.aborted) {
      const key = keys[cursor++];
      let entry = cache.get(key);
      if (!entry || (!reuse && Date.now() - entry.time >= CACHE_MS)) {
        try { entry = { data: await loadPRMetadata(key, abort.signal), time: Date.now() }; }
        catch (error) {
          if (abort.signal.aborted) return;
          const message = error.name === 'TimeoutError' ? 'Loading timed out. Open the PR or retry.' : error.message;
          entry = { data: entry?.data, error: entry?.data ? `Could not refresh. Showing last loaded details. ${message}` : message, time: Date.now() };
        }
        if (abort.signal.aborted || run !== generation) return;
        cache.set(key, entry);
      }
      if (!abort.signal.aborted && run === generation) {
        if (rows?.has(key)) updateRow(rows.get(key), entry);
        progress?.(++completed);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(keys.length, 4) }, () => worker()));
}

$('#label-filter').addEventListener('change', writeFilters);
$('#repo-filter').addEventListener('change', writeFilters);
$('#clear-filters').addEventListener('click', () => {
  $('#label-filter').value = ''; $('#repo-filter').value = ''; writeFilters();
});
$('#sort-field').addEventListener('change', () => changeSort($('#sort-field').value));
$('#sort-direction').addEventListener('click', () => { const sort = readSort(); changeSort(sort.field, !sort.descending); });
for (const button of document.querySelectorAll('[data-sort]')) button.addEventListener('click', () => {
  const sort = readSort();
  changeSort(button.dataset.sort, sort.field === button.dataset.sort && !sort.descending);
});
$('#refresh-details').addEventListener('click', () => { expireDetails(readSort().field ? [...cache.keys()] : visibleKeys); render(); });
$('#previous-page').addEventListener('click', () => { page--; render(); });
$('#next-page').addEventListener('click', () => { page++; render(); });
window.addEventListener('hashchange', () => { page = 1; render(); });
window.addEventListener('pagehide', () => { persistCache(); controller?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted) render(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state && $('#task-results').getAttribute('aria-busy') !== 'true' && visibleKeys.some(key => !fresh(key))) render();
});
function receiveState(next) {
  // A service worker reconnection often returns the exact same saved labels.
  if (state && JSON.stringify(state) === JSON.stringify(next)) return;
  state = next;
  render();
}

function connect() {
  if (!chrome.runtime?.id) return;
  const port = chrome.runtime.connect({ name: 'github-task-tracker' });
  port.onMessage.addListener(receiveState);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (chrome.runtime?.id) setTimeout(connect, 1000); });
  request({ type: 'get' }).then(receiveState).catch(error => {
    notify(error.message, true);
    $('#task-results').setAttribute('aria-busy', 'false');
    showRefreshProgress(0, 0);
    if (!state) {
      $('#empty-tasks').hidden = false;
      $('#empty-tasks').textContent = 'Could not load saved tasks. Reload this page to try again.';
    }
  });
}
connect();
