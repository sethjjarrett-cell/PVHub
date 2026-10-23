/* =====================================================================
   TRACKER STORAGE
   ---------------------------------------------------------------------
   Where the tracked projects actually live.

   The default, where the browser allows it, is a file the user picks on
   their own disk — a project folder, a synced drive, wherever they keep
   the reports themselves. Nothing is then held in browser storage, which
   is the point: this application is served from a public origin, and
   localStorage on a public origin is plain text readable by anything
   running there and by anyone with the machine.

   The File System Access API is Chrome and Edge. Firefox and Safari do
   not have it, and there the store falls back to localStorage and the
   interface says which one is in use rather than letting the user assume
   the stronger guarantee.

   One thing does go in browser storage in file mode: the file *handle*,
   in IndexedDB, so the tracker can reconnect to the same file after a
   reload instead of asking every time. A handle is a reference, not the
   data — it carries no project records. The browser still requires a
   gesture to re-grant permission on a new session, so reconnecting is a
   button rather than something that happens silently.
   ================================================================== */

export const LS_KEY = "pvhub.tracker.v1";
const IDB_NAME = "pvhub-tracker";
const IDB_STORE = "handles";
const IDB_KEY = "file";

/** Chrome and Edge, on a secure context. */
export function supportsFileStore() {
  return typeof window !== "undefined"
    && typeof window.showSaveFilePicker === "function"
    && typeof window.indexedDB !== "undefined";
}

const PICKER_TYPES = [{
  description: "PVhub tracker",
  accept: { "application/json": [".json"] },
}];

/* ---------- the handle, kept in IndexedDB ------------------------- */

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDelete(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** The saved handle, if there is one. Does not ask for permission —
    that needs a user gesture, so the interface offers a button. */
export async function savedHandle() {
  if (!supportsFileStore()) return null;
  try { return await idbGet(IDB_KEY); } catch (e) { return null; }
}

export async function forgetHandle() {
  try { await idbDelete(IDB_KEY); } catch (e) { /* nothing to forget */ }
}

/** "granted" | "prompt" | "denied" | "gone" */
export async function handleState(handle) {
  if (!handle) return "gone";
  try {
    const q = await handle.queryPermission({ mode: "readwrite" });
    return q;
  } catch (e) { return "gone"; }
}

/** Must be called from a click. Returns true if writable. */
export async function grantHandle(handle) {
  if (!handle) return false;
  try {
    if (await handle.queryPermission({ mode: "readwrite" }) === "granted") return true;
    return await handle.requestPermission({ mode: "readwrite" }) === "granted";
  } catch (e) { return false; }
}

/* ---------- picking, reading and writing --------------------------- */

/* Remembering the handle is a convenience, not the feature. IndexedDB
   is blocked outright in some private-browsing modes, so a failure here
   must not stop the file being used for this session — it only costs
   the automatic reconnection next time. */
async function rememberHandle(handle) {
  try { await idbPut(IDB_KEY, handle); return true; }
  catch (e) { return false; }
}

/** Create or overwrite a tracker file. From a click. */
export async function chooseNewFile() {
  const handle = await window.showSaveFilePicker({
    suggestedName: "pvhub-tracker.json",
    types: PICKER_TYPES,
  });
  const remembered = await rememberHandle(handle);
  return { handle, remembered };
}

/** Open an existing tracker file. From a click. */
export async function chooseExistingFile() {
  const [handle] = await window.showOpenFilePicker({
    types: PICKER_TYPES, multiple: false,
  });
  const remembered = await rememberHandle(handle);
  return { handle, remembered };
}

export async function readHandle(handle) {
  const file = await handle.getFile();
  const text = await file.text();
  return text && text.trim() ? text : null;
}

export async function writeHandle(handle, text) {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

/* ---------- the browser-storage fallback --------------------------- */

export function readLocal() {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw && raw.trim() ? raw : null;
  } catch (e) { return null; }
}

export function writeLocal(text) {
  try { window.localStorage.setItem(LS_KEY, text); return true; }
  catch (e) { return false; }
}

/** Used when the user moves to a file: the whole point is that the
    records stop living in the browser, so the copy there goes. */
export function clearLocal() {
  try { window.localStorage.removeItem(LS_KEY); return true; }
  catch (e) { return false; }
}

export function hasLocal() {
  return readLocal() !== null;
}

/* ---------- the startup decision ------------------------------------
   Pulled out as a pure function because it is the part with branches,
   and the browser halves around it (a picker, a permission prompt) can
   only be driven by a human. Testing this separately is the difference
   between "the code reads right" and "the code is checked".

   @param supported  does this browser have the File System Access API
   @param state      "granted" | "prompt" | "denied" | "gone" | null
   @returns "file"   reopen the file now
            "grant"  offer a Reconnect button; the browser needs a gesture
            "forget" drop the stored handle, it is dead
            "local"  browser storage
   ------------------------------------------------------------------ */
export function startupPlan(supported, state) {
  if (!supported) return "local";
  if (state === "granted") return "file";
  if (state === "prompt") return "grant";
  if (state === "denied" || state === "gone") return "forget";
  return "local";
}

/* ---------- what the interface shows ------------------------------- */

/**
 * One sentence describing where the records are, for the status line.
 * Separated from the component so it can be read — and corrected —
 * without reading JSX.
 */
export function describeStore(mode, fileName, supported) {
  if (mode === "file") {
    return `Saving to ${fileName || "the file you chose"} on this machine. Nothing is kept in `
      + "browser storage; only a reference to the file is, so it can reconnect after a reload.";
  }
  if (mode === "memory") {
    return "Held in this tab only. Nothing is written anywhere — close the tab and the list "
      + "is gone unless you have exported it.";
  }
  return supported
    ? "Held in this browser's local storage, on the site's own origin — readable by anyone "
      + "with this machine and this browser profile. Choose a file above to keep it out of "
      + "the browser entirely."
    : "Held in this browser's local storage. This browser has no File System Access API "
      + "(that is Chrome and Edge), so saving straight to a file is not available here — "
      + "export the JSON to keep an archive.";
}
