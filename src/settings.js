import { validateState, MAX_IMPORT_BYTES, trackedPRKeys } from './model.js';

const $ = selector => document.querySelector(selector);
let state;
let pendingImport;
let busy = false;
let pendingDeleteId = null;

$('#delete-dialog').addEventListener('close', () => {
  const id = pendingDeleteId;
  pendingDeleteId = null;
  if ($('#delete-dialog').returnValue === 'delete' && id !== null) {
    mutate({ type: 'deleteLabel', labelId: id }, 'Label deleted.');
  }
});

async function request(operation) {
  const response = await chrome.runtime.sendMessage({ scope: 'github-task-tracker', ...operation });
  if (!response?.ok) throw new Error(response?.error || 'Extension unavailable. Reload this page and try again.');
  return response.data;
}

function notify(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').className = error ? 'error' : '';
}

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function mutate(operation, message) {
  if (busy) return false;
  busy = true;
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    state = await request(operation);
    render();
    notify(message);
    return true;
  } catch (error) { notify(error.message, true); return false; }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
}

function render() {
  $('#labels').replaceChildren();
  $('#preview-labels').replaceChildren();
  $('#label-count').textContent = state.labels.length;
  const count = trackedPRKeys(state).length;
  $('#data-summary').textContent = `${state.labels.length} labels · ${count} tracked pull request${count === 1 ? '' : 's'}`;
  if (!state.labels.length) $('#labels').append(node('p', 'No labels yet. Add your first one below.', 'hint'));
  state.labels.forEach((label, index) => {
    const form = node('form', '', 'label-row');
    const color = node('input');
    color.type = 'color'; color.value = label.color; color.setAttribute('aria-label', `Color for ${label.name}`);
    const name = node('input');
    name.type = 'text'; name.value = label.name; name.required = true; name.maxLength = 60;
    name.setAttribute('aria-label', `Name for ${label.name}`);
    const usage = Object.values(state.pullRequests).filter(ids => ids.includes(label.id)).length;
    const countNode = node('a', `${usage} PR`, 'usage');
    countNode.href = `tasks.html#${new URLSearchParams({ label: label.id })}`;
    countNode.setAttribute('aria-label', `View PRs with ${label.name} across repositories`);
    countNode.title = `Used on ${usage} pull requests`;
    const save = node('button', 'Save'); save.type = 'submit';
    const remove = node('button', '×', 'delete'); remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${label.name}`);
    form.append(color, name, countNode, save, remove);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      await mutate({ type: 'saveLabel', label: { id: label.id, name: name.value, color: color.value } }, 'Label saved. Your GitHub lists update automatically.');
    });
    remove.addEventListener('click', () => {
      const dialog = $('#delete-dialog');
      // Keep one confirmation target until its close event has been handled.
      if (busy || dialog.open || pendingDeleteId !== null) return;
      $('#delete-description').textContent = `“${label.name}” will be removed from all PRs using it. This cannot be undone without a backup.`;
      pendingDeleteId = label.id;
      dialog.returnValue = '';
      dialog.showModal();
    });
    $('#labels').append(form);
    if (index < 2) {
      const badge = node('span', '', 'badge');
      const rgb = label.color.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255);
      const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      badge.style.backgroundColor = label.color;
      badge.style.color = luminance > 0.179 ? '#000' : '#fff';
      badge.textContent = label.name;
      $('#preview-labels').append(badge);
    }
  });
}

$('#add-label').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state) return;
  const success = await mutate({ type: 'saveLabel', label: { id: crypto.randomUUID(), name: $('#new-name').value, color: $('#new-color').value } }, 'Label added. It’s ready to use on GitHub.');
  if (success) { $('#new-name').value = ''; $('#new-name').focus(); }
});

$('#export').addEventListener('click', async () => {
  try {
    // Read a fresh snapshot so assignments from another tab are included.
    const latest = await request({ type: 'get' });
    const data = { ...latest, exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const link = node('a'); link.href = url;
    link.download = `github-task-tracker-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notify('Backup exported. Keep this file somewhere private.');
  } catch (error) { notify(error.message, true); }
});

$('#import').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  pendingImport = undefined;
  $('#import-preview').hidden = true;
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('The backup is too large. Maximum file size is 5 MB.');
    pendingImport = validateState(JSON.parse(await file.text()));
    $('#import-summary').textContent = `${pendingImport.labels.length} labels and ${trackedPRKeys(pendingImport).length} pull requests, including ${Object.keys(pendingImport.notes).length} notes, in “${file.name}”.`;
    $('#import-preview').hidden = false;
    $('#confirm-import').focus();
    notify('Backup checked. Review it below before replacing your data.');
  } catch (error) { notify(`Import failed: ${error.message}`, true); }
});

$('#cancel-import').addEventListener('click', () => { pendingImport = undefined; $('#import-preview').hidden = true; notify('Import canceled.'); });
$('#confirm-import').addEventListener('click', async () => {
  if (!pendingImport) return;
  if (await mutate({ type: 'replace', state: pendingImport }, 'Backup imported. Your GitHub lists have been updated.')) {
    pendingImport = undefined;
    $('#import-preview').hidden = true;
  }
});

async function initialize() {
  try { state = await request({ type: 'get' }); render(); }
  catch (error) { notify(error.message, true); }
}
initialize();
