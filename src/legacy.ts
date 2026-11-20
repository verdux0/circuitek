/**
 * The app was called "glitch-editor" before "circuitek". Data saved under the old names
 * (localStorage keys and IndexedDB databases) is moved to the new ones so nothing is lost.
 * Imported first in main.ts, so the localStorage part runs before anything reads it.
 */
import { createStore, entries, setMany, keys, type UseStore } from 'idb-keyval';

const LS_KEYS: [string, string][] = [
  ['glitch-editor:state:v1', 'circuitek:state:v1'],
  ['glitch-editor:tab', 'circuitek:tab'],
  ['glitch-editor:theme', 'circuitek:theme'],
  ['glitch-editor:collapsed', 'circuitek:collapsed'],
  ['glitch-editor:export', 'circuitek:export'],
  ['glitch-editor.fonts.favs', 'circuitek.fonts.favs'],
  ['glitch-editor.fonts.recent', 'circuitek.fonts.recent'],
];

try {
  for (const [from, to] of LS_KEYS) {
    const v = localStorage.getItem(from);
    if (v === null) continue;
    if (localStorage.getItem(to) === null) localStorage.setItem(to, v);
    localStorage.removeItem(from);
  }
} catch {
  /* storage unavailable */
}

/** Old IndexedDB database name for each new one. */
const IDB_NAMES: Record<string, string> = {
  circuitek: 'glitch-editor',
  'circuitek-projects': 'glitch-editor-projects',
  'circuitek-export': 'glitch-editor-export',
};

const done = new Map<string, Promise<void>>();

async function oldDbExists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== 'function') return true; // cannot tell: try to copy
  return (await indexedDB.databases()).some((d) => d.name === name);
}

async function copy(oldName: string, storeName: string, target: UseStore): Promise<void> {
  if (!(await oldDbExists(oldName))) return;
  const old = createStore(oldName, storeName);
  const rows = await entries(old);
  if (rows.length && (await keys(target)).length === 0) await setMany(rows, target);
  await old('readonly', (s) => s.transaction.db.close());
  indexedDB.deleteDatabase(oldName);
}

/**
 * Copies the old database into `target` (only if `target` is still empty), once per page.
 * Never throws: a failed migration just starts empty, as before.
 */
export function migrateIdb(newName: string, storeName: string, target: UseStore): Promise<void> {
  const oldName = IDB_NAMES[newName];
  if (!oldName) return Promise.resolve();
  let p = done.get(newName);
  if (!p) {
    p = copy(oldName, storeName, target).catch(() => {});
    done.set(newName, p);
  }
  return p;
}
