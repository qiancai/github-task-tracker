import { STORAGE_KEY, initialState, validateState, applyOperation } from './model.js';

// Serialize every read/write so simultaneous tabs cannot overwrite each other.
let queue = Promise.resolve();
let accessReady;
function ensureStorageAccess() {
  // Cache successful initialization, but let a later request retry a transient failure.
  if (!accessReady) {
    accessReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(error => {
      accessReady = undefined;
      throw new Error(`Could not initialize private storage. Try again or reload the extension. Details: ${error.message}`);
    });
  }
  return accessReady;
}
const subscribers = new Set();
async function openTasks() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('tasks.html') });
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'github-task-tracker' || port.sender?.id !== chrome.runtime.id) return;
  subscribers.add(port);
  port.onDisconnect.addListener(() => subscribers.delete(port));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.scope !== 'github-task-tracker') return;
  const task = queue.then(async () => {
    if (message.type === 'openSettings') {
      await chrome.runtime.openOptionsPage();
      return null;
    }
    if (message.type === 'openTasks') {
      await openTasks();
      return null;
    }
    await ensureStorageAccess();
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const current = stored === undefined ? initialState() : validateState(stored);
    if (message.type === 'get') return current;
    const next = applyOperation(current, message);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    for (const port of subscribers) {
      try { port.postMessage(next); } catch { subscribers.delete(port); }
    }
    return next;
  });
  queue = task.catch(() => {});
  task.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(openTasks);
