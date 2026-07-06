// Tiny IndexedDB store so scanned pages survive a reload / accidental close.
// Everything is local to the browser — nothing is uploaded. All calls are
// defensive: if IndexedDB is unavailable, they no-op and the tool still works
// fully in memory.

import type { Pt, ScanFilter } from "./scanner";

export interface StoredPage {
  id: string;
  order: number;
  srcUrl: string;   // original photo (data URL) — needed to re-edit
  corners: Pt[];
  filter: ScanFilter;
  thumb: string;    // small preview (data URL)
  out: string;      // processed result (JPEG data URL)
}

const DB_NAME = "macm-scanner";
const STORE = "pages";

function openDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export async function idbAllPages(): Promise<StoredPage[]> {
  const db = await openDB();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredPage[]) || [];
        rows.sort((a, b) => a.order - b.order);
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

export async function idbPutPage(p: StoredPage): Promise<void> {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(p);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export async function idbDeletePage(id: string): Promise<void> {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export async function idbSetOrder(ids: string[]): Promise<void> {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      ids.forEach((id, order) => {
        const g = store.get(id);
        g.onsuccess = () => { const r = g.result as StoredPage | undefined; if (r) { r.order = order; store.put(r); } };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export async function idbClear(): Promise<void> {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}
