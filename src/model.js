export const STORAGE_KEY = 'githubTaskTracker';
export const MAX_NOTE_LENGTH = 2000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LABELS = [
  { id: 'wait-review', name: 'Wait for review', color: '#8250df' },
  { id: 'pending-self', name: 'Pending by me', color: '#0969da' },
  { id: 'pending-engineer', name: 'Pending by engineer', color: '#9a6700' },
  { id: 'ready-merge', name: 'Ready to merge', color: '#1a7f37' }
];

export function initialState() {
  return { version: 1, labels: structuredClone(DEFAULT_LABELS), pullRequests: {}, notes: {} };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeKey(key) {
  requireValue(typeof key === 'string' && /^[\w-]+\/[\w.-]+#[1-9]\d{0,9}$/.test(key), 'Invalid pull request identifier.');
  return key.toLowerCase();
}

export function validateLabel(label) {
  requireValue(label && typeof label === 'object', 'Invalid label.');
  requireValue(typeof label.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(label.id), 'Invalid label ID.');
  requireValue(typeof label.name === 'string' && label.name.trim().length > 0 && label.name.trim().length <= 60, 'Label names must contain 1–60 characters.');
  requireValue(typeof label.color === 'string' && /^#[\da-f]{6}$/i.test(label.color), 'Choose a valid label color.');
  return { id: label.id, name: label.name.trim(), color: label.color.toLowerCase() };
}

export function trackedPRKeys(state) {
  // Labels determine tracking; keep notes for reuse without keeping unlabeled PRs in My tasks.
  return Object.keys(state.pullRequests).filter(key => state.pullRequests[key].length);
}

export function validateState(input) {
  requireValue(input && input.version === 1, 'Unsupported backup format. Expected version 1.');
  requireValue(Array.isArray(input.labels) && input.labels.length <= 100, 'Backups can contain at most 100 labels.');
  const labels = input.labels.map(validateLabel);
  // Retain assignments when upgrading the original default name, without overriding custom names.
  const legacySelfLabel = labels.find(label => label.id === 'pending-self' && label.name === 'Pending by myself');
  if (legacySelfLabel && !labels.some(label => label.name.toLowerCase() === 'pending by me')) legacySelfLabel.name = 'Pending by me';
  const ids = new Set(labels.map(label => label.id));
  requireValue(ids.size === labels.length, 'Duplicate label IDs in backup.');
  requireValue(new Set(labels.map(label => label.name.toLowerCase())).size === labels.length, 'Label names must be unique.');
  requireValue(input.pullRequests && typeof input.pullRequests === 'object' && !Array.isArray(input.pullRequests), 'Invalid pull request data.');
  const entries = Object.entries(input.pullRequests);
  requireValue(entries.length <= 10000, 'Backups can contain at most 10,000 pull requests.');
  const pullRequests = {};
  for (const [key, selection] of entries) {
    const normalized = normalizeKey(key);
    requireValue(!Object.hasOwn(pullRequests, normalized), 'Duplicate pull request identifiers in backup.');
    requireValue(Array.isArray(selection) && selection.length <= 100 && selection.every(id => ids.has(id)), 'A pull request references an unknown label.');
    pullRequests[normalized] = [...new Set(selection)];
  }
  const sourceNotes = input.notes === undefined ? {} : input.notes;
  requireValue(sourceNotes && typeof sourceNotes === 'object' && !Array.isArray(sourceNotes), 'Invalid notes data.');
  const noteEntries = Object.entries(sourceNotes);
  requireValue(noteEntries.length <= 10000, 'Backups can contain notes for at most 10,000 pull requests.');
  const notes = {};
  const noteKeys = new Set();
  for (const [key, text] of noteEntries) {
    const normalized = normalizeKey(key);
    requireValue(!noteKeys.has(normalized), 'Duplicate note identifiers in backup.');
    noteKeys.add(normalized);
    requireValue(typeof text === 'string' && text.length <= MAX_NOTE_LENGTH, `Notes can contain at most ${MAX_NOTE_LENGTH.toLocaleString('en-US')} characters.`);
    if (text.trim()) notes[normalized] = text;
  }
  requireValue(new Set([...Object.keys(pullRequests), ...Object.keys(notes)]).size <= 10000, 'Backups can contain at most 10,000 pull requests.');
  return { version: 1, labels, pullRequests, notes };
}

export function applyOperation(current, operation) {
  const state = structuredClone(current);
  switch (operation.type) {
    case 'setNote': {
      const key = normalizeKey(operation.key);
      requireValue(trackedPRKeys(state).includes(key), 'This PR is no longer tracked. Close the note editor.');
      requireValue(typeof operation.text === 'string' && operation.text.length <= MAX_NOTE_LENGTH, 'Notes can contain at most 2,000 characters.');
      requireValue(typeof operation.expectedText === 'string' && (state.notes?.[key] || '') === operation.expectedText, 'This note changed in another tab. Load the latest note before saving.');
      state.notes ||= {};
      if (operation.text.trim()) state.notes[key] = operation.text;
      else delete state.notes[key];
      break;
    }
    case 'setLabel': {
      const key = normalizeKey(operation.key);
      requireValue(state.labels.some(label => label.id === operation.labelId), 'This label was removed. Reopen the editor.');
      requireValue(typeof operation.selected === 'boolean', 'Invalid label selection.');
      const ids = new Set(state.pullRequests[key] || []);
      if (operation.selected) ids.add(operation.labelId);
      else ids.delete(operation.labelId);
      if (ids.size) state.pullRequests[key] = [...ids];
      else delete state.pullRequests[key];
      break;
    }
    case 'saveLabel': {
      const label = validateLabel(operation.label);
      requireValue(!state.labels.some(item => item.id !== label.id && item.name.toLowerCase() === label.name.toLowerCase()), 'A label with this name already exists. Choose a different name.');
      const index = state.labels.findIndex(item => item.id === label.id);
      if (index < 0) state.labels.push(label);
      else state.labels[index] = label;
      break;
    }
    case 'createAndAssignLabel': {
      const key = normalizeKey(operation.key);
      const label = validateLabel(operation.label);
      requireValue(!state.labels.some(item => item.id === label.id), 'This label already exists. Choose it from the list.');
      requireValue(!state.labels.some(item => item.name.toLowerCase() === label.name.toLowerCase()), 'A label with this name already exists. Select it above.');
      // Validate and persist creation plus assignment together, so a failed save leaves neither behind.
      state.labels.push(label);
      state.pullRequests[key] = [...new Set([...(state.pullRequests[key] || []), label.id])];
      break;
    }
    case 'addLabelsToPRs':
    case 'updateLabelsOnPRs': {
      requireValue(Array.isArray(operation.keys) && operation.keys.length > 0 && operation.keys.length <= 1000, 'Select between 1 and 1,000 PRs.');
      const keys = [...new Set(operation.keys.map(normalizeKey))];
      requireValue(keys.every(key => state.pullRequests[key]?.length), 'A selected PR is no longer tracked. Close this dialog and select your PRs again.');
      requireValue(Array.isArray(operation.labelIds) && operation.labelIds.length <= 100, 'Choose valid labels to add.');
      requireValue(operation.labelIds.every(id => state.labels.some(label => label.id === id)), 'A selected label was removed. Choose the labels again.');
      const removals = operation.removeLabelIds === undefined ? [] : operation.removeLabelIds;
      requireValue(Array.isArray(removals) && removals.length <= 100, 'Choose valid labels to remove.');
      requireValue(operation.type !== 'addLabelsToPRs' || removals.length === 0, 'Use updateLabelsOnPRs to remove labels.');
      requireValue(removals.every(id => state.labels.some(label => label.id === id)), 'A selected label was removed. Choose the labels again.');
      const removeIds = new Set(removals);
      requireValue(!operation.labelIds.some(id => removeIds.has(id)), 'A label cannot be added and removed in the same update.');
      const ids = new Set(operation.labelIds);
      if (operation.newLabel) {
        const label = validateLabel(operation.newLabel);
        requireValue(!state.labels.some(item => item.id === label.id || item.name.toLowerCase() === label.name.toLowerCase()), 'A label with this name already exists. Choose it from the list.');
        state.labels.push(label);
        ids.add(label.id);
      }
      requireValue(ids.size > 0 || removeIds.size > 0, 'Choose at least one label to change.');
      // Validate and save the entire batch once; a failure cannot leave a partial update.
      for (const key of keys) {
        const updated = [...new Set([...(state.pullRequests[key] || []).filter(id => !removeIds.has(id)), ...ids])];
        if (updated.length) state.pullRequests[key] = updated;
        else delete state.pullRequests[key];
      }
      break;
    }
    case 'moveLabel': {
      requireValue(typeof operation.after === 'boolean', 'Invalid label position.');
      const index = state.labels.findIndex(label => label.id === operation.labelId);
      requireValue(index >= 0 && state.labels.some(label => label.id === operation.targetId), 'A label was removed. Reopen the label list and try again.');
      if (operation.labelId === operation.targetId) break;
      // Move relative to the latest state so concurrent additions and renames are preserved.
      const [label] = state.labels.splice(index, 1);
      const target = state.labels.findIndex(label => label.id === operation.targetId);
      state.labels.splice(target + (operation.after ? 1 : 0), 0, label);
      break;
    }
    case 'deleteLabel':
      state.labels = state.labels.filter(label => label.id !== operation.labelId);
      for (const [key, ids] of Object.entries(state.pullRequests)) {
        const remaining = ids.filter(id => id !== operation.labelId);
        if (remaining.length) state.pullRequests[key] = remaining;
        else delete state.pullRequests[key];
      }
      break;
    case 'replace':
      return validateState(operation.state);
    default:
      throw new Error('Unknown operation.');
  }
  return validateState(state);
}
