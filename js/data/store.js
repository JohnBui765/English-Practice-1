// App data API on top of IndexedDB: lists, spaced-repetition progress,
// settings, practice history, backup export/import.
import * as db from './db.js';

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  voiceURI: '',
  speechRate: 0.9,
  autoSpeak: true,
  clozeAnswer: 'bank',
  autoAdvance: 0,
  dictationHideAfter: 0,
  dictationStart: 'read',
  familyDifficulty: 'intermediate',
  familyDuplicates: 'contextual',
  ignoreAccents: false,
  sentencesPerSense: 1,
  level: 'B2',
  reviewLimit: 20,
  familyTranslate: true, // ask Claude for Vietnamese translations of family examples
});

const APP_ID = 'vocab-studio';
const BACKUP_VERSION = 1;

/* ---------- change events ---------- */

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(detail) {
  for (const fn of listeners) {
    try {
      fn(detail);
    } catch (err) {
      console.error(err);
    }
  }
}

/* ---------- lists ---------- */

export async function getLists() {
  const lists = await db.getAll('lists');
  return lists.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getList(id) {
  if (!id) return null;
  return (await db.get('lists', id)) || null;
}

export async function saveList(list, { touch = true } = {}) {
  const now = Date.now();
  const value = {
    sentences: [],
    source: '',
    rawText: '',
    lastPracticedAt: null,
    createdAt: now,
    ...list,
  };
  if (touch || !value.updatedAt) value.updatedAt = now;
  await db.put('lists', value);
  requestPersistence();
  emit({ store: 'lists', id: value.id });
  return value;
}

export async function deleteList(id) {
  await db.del('lists', id);
  await db.delWhere('progress', 'listId', id);
  emit({ store: 'lists', id, deleted: true });
}

/* ---------- progress ---------- */

export async function getProgress(itemIds) {
  const map = new Map();
  if (Array.isArray(itemIds)) {
    const values = await Promise.all(itemIds.map((id) => db.get('progress', id)));
    values.forEach((v) => v && map.set(v.itemId, v));
  } else {
    (await db.getAll('progress')).forEach((v) => map.set(v.itemId, v));
  }
  return map;
}

export async function getProgressForList(listId) {
  const map = new Map();
  (await db.getAll('progress', { index: 'listId', query: listId })).forEach((v) => map.set(v.itemId, v));
  return map;
}

export async function saveProgress(progressArray) {
  if (!progressArray.length) return;
  await db.putMany('progress', progressArray);
  emit({ store: 'progress' });
}

/* ---------- settings ---------- */

let settingsCache = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
  const rows = await db.getAll('settings');
  settingsCache = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) settingsCache[key] = value;
  }
  return { ...settingsCache };
}

export async function getSettings() {
  return { ...settingsCache };
}

// Synchronous read of the cached settings (valid after loadSettings()).
export function settings() {
  return settingsCache;
}

export async function setSetting(key, value) {
  settingsCache = { ...settingsCache, [key]: value };
  await db.put('settings', { key, value });
  emit({ store: 'settings', key, value });
}

/* ---------- history ---------- */

export async function addHistory(entry) {
  const value = { at: Date.now(), listId: null, ...entry };
  delete value.id;
  await db.put('history', value);
  emit({ store: 'history' });
}

export async function getHistory({ listId, limit = 200 } = {}) {
  const rows = listId ? await db.getAll('history', { index: 'listId', query: listId }) : await db.getAll('history');
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

/* ---------- backup ---------- */

export async function exportAll() {
  const [lists, progress, settingsRows, history] = await Promise.all([
    db.getAll('lists'),
    db.getAll('progress'),
    db.getAll('settings'),
    db.getAll('history'),
  ]);
  return {
    app: APP_ID,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    lists,
    progress,
    settings: Object.fromEntries(settingsRows.map((r) => [r.key, r.value])),
    history: history.map(({ id, ...rest }) => rest),
  };
}

export function validateBackup(data) {
  if (!data || typeof data !== 'object' || data.app !== APP_ID) {
    throw new Error('This file is not a Vocab Studio backup.');
  }
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of the app.');
  }
  if (!Array.isArray(data.lists)) throw new Error('The backup has no lists.');
  return true;
}

// mode 'replace' wipes current data first; 'merge' keeps the newer copy of
// each list / progress record and adds history entries that are not present.
export async function importAll(data, { mode = 'merge' } = {}) {
  validateBackup(data);
  const lists = data.lists.filter((l) => l && typeof l.id === 'string' && Array.isArray(l.items));
  const progress = (data.progress || []).filter((p) => p && typeof p.itemId === 'string');
  const history = (data.history || []).filter((h) => h && typeof h.at === 'number');

  if (mode === 'replace') {
    // One transaction: an interruption never leaves the data half wiped.
    const settingsRows = Object.entries(data.settings || {})
      .filter(([key]) => key in DEFAULT_SETTINGS)
      .map(([key, value]) => ({ key, value }));
    await db.replaceAll({ lists, progress, history: history.map(({ id, ...rest }) => rest) }, { settings: settingsRows });
    await loadSettings();
  } else {
    const existingLists = new Map((await db.getAll('lists')).map((l) => [l.id, l]));
    const newerLists = lists.filter((l) => !existingLists.has(l.id) || (l.updatedAt || 0) > (existingLists.get(l.id).updatedAt || 0));
    await db.putMany('lists', newerLists);
    const existingProgress = await getProgress();
    const newerProgress = progress.filter((p) => !existingProgress.has(p.itemId) || (p.last || 0) > (existingProgress.get(p.itemId).last || 0));
    await db.putMany('progress', newerProgress);
    const seen = new Set((await db.getAll('history')).map((h) => `${h.at}|${h.listId}|${h.mode}`));
    await db.putMany(
      'history',
      history.filter((h) => !seen.has(`${h.at}|${h.listId}|${h.mode}`)).map(({ id, ...rest }) => rest),
    );
  }
  emit({ store: 'all' });
  return { lists: lists.length };
}

/* ---------- storage durability ---------- */

let persistAsked = false;

export async function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}

export async function storageStatus() {
  const status = { persistent: false, usage: 0, quota: 0, durable: db.isPersistentStorage() };
  try {
    if (navigator.storage?.persisted) status.persistent = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      status.usage = est.usage || 0;
      status.quota = est.quota || 0;
    }
  } catch {
    /* not supported */
  }
  return status;
}

export { open as openDatabase, isPersistentStorage } from './db.js';
