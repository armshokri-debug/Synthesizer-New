/**
 * SY-1 Studio — IndexedDB Persistence, Autosave & Crash Recovery
 *
 * Stores user-saved projects and a dedicated rolling autosave slot in IndexedDB
 * without ever touching standalone SY-1 localStorage keys. Classifies and handles
 * QuotaExceededError, SecurityError/unavailable storage, and corrupted records
 * gracefully with zero unhandled rejections.
 */

import { summarizeProjectMeta, validateStudioProject } from "./project-io";
import type { StorageErrorKind, StudioProjectData, StudioSavedProjectMeta } from "./types";

export const STUDIO_DB_NAME = "sy1-studio-db";
export const STUDIO_DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_AUTOSAVE = "autosave";
const AUTOSAVE_SLOT = "latest";

export type StorageResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: StorageErrorKind; message: string };

interface AutosaveRecord {
  slot: string;
  updatedAt: number;
  project: StudioProjectData;
}

export interface StudioStorageAdapter {
  isAvailable(): boolean;
  saveProject(project: StudioProjectData): Promise<StorageResult<StudioSavedProjectMeta>>;
  loadProject(id: string): Promise<StorageResult<StudioProjectData | null>>;
  listProjects(): Promise<StorageResult<StudioSavedProjectMeta[]>>;
  deleteProject(id: string): Promise<StorageResult<void>>;
  saveAutosave(project: StudioProjectData): Promise<StorageResult<number>>;
  loadAutosave(): Promise<StorageResult<{ project: StudioProjectData; updatedAt: number } | null>>;
  clearAutosave(): Promise<StorageResult<void>>;
}

export function classifyStorageError(err: unknown): { kind: StorageErrorKind; message: string } {
  const e = err as { name?: string; message?: string; code?: number } | null;
  const name = String(e?.name || "");
  const msg = String(e?.message || "");
  const code = Number(e?.code || 0);

  if (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014 ||
    /quota|storage.*full|disk.*full/i.test(msg)
  ) {
    return {
      kind: "quota",
      message: "Browser storage quota exceeded. Export a .sy1studio backup or delete old saved projects."
    };
  }
  if (
    name === "SecurityError" ||
    name === "InvalidStateError" ||
    /indexeddb.*disabled|not allowed|private/i.test(msg)
  ) {
    return {
      kind: "unavailable",
      message: "Local browser storage (IndexedDB) is unavailable in this browsing context."
    };
  }
  return {
    kind: "io",
    message: msg ? `Storage error: ${msg}` : "Local storage operation failed."
  };
}

export function createStudioStorage(opts: {
  indexedDB?: IDBFactory | null;
  dbName?: string;
} = {}): StudioStorageAdapter {
  const dbName = opts.dbName || STUDIO_DB_NAME;

  const getFactory = (): IDBFactory | null => {
    if (opts.indexedDB !== undefined) return opts.indexedDB;
    if (typeof indexedDB !== "undefined") return indexedDB;
    return null;
  };

  let dbPromise: Promise<IDBDatabase> | null = null;

  const openDb = (): Promise<IDBDatabase> => {
    const factory = getFactory();
    if (!factory) {
      return Promise.reject(Object.assign(new Error("IndexedDB unavailable"), { name: "SecurityError" }));
    }
    if (dbPromise) return dbPromise;

    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(dbName, STUDIO_DB_VERSION);
      } catch (err) {
        dbPromise = null;
        reject(err);
        return;
      }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_AUTOSAVE)) {
          db.createObjectStore(STORE_AUTOSAVE, { keyPath: "slot" });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error("Failed to open IndexedDB"));
      };

      req.onblocked = () => {
        dbPromise = null;
        reject(new Error("IndexedDB open blocked by another tab"));
      };
    });

    return dbPromise;
  };

  const runTx = async <T>(
    storeName: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeName, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(storeName);
      let req: IDBRequest<T>;
      try {
        req = work(store);
      } catch (err) {
        reject(err);
        return;
      }

      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      req.onerror = () => {
        reject(req.error || tx.error || new Error("IndexedDB request failed"));
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || req.error || new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error || req.error || new Error("IndexedDB transaction error"));
    });
  };

  return {
    isAvailable(): boolean {
      return getFactory() !== null;
    },

    async saveProject(project: StudioProjectData): Promise<StorageResult<StudioSavedProjectMeta>> {
      const check = validateStudioProject(project);
      if (!check.ok) {
        return { ok: false, kind: "corrupt", message: check.error };
      }
      const record: StudioProjectData = { ...check.project, savedAt: Date.now() };
      try {
        await runTx(STORE_PROJECTS, "readwrite", (store) => store.put(record));
        return { ok: true, data: summarizeProjectMeta(record) };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    },

    async loadProject(id: string): Promise<StorageResult<StudioProjectData | null>> {
      try {
        const raw = await runTx<unknown>(STORE_PROJECTS, "readonly", (store) => store.get(id));
        if (!raw) return { ok: true, data: null };
        const check = validateStudioProject(raw);
        if (!check.ok) {
          return { ok: false, kind: "corrupt", message: `Saved project is corrupted: ${check.error}` };
        }
        return { ok: true, data: check.project };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    },

    async listProjects(): Promise<StorageResult<StudioSavedProjectMeta[]>> {
      try {
        const all = await runTx<unknown[]>(STORE_PROJECTS, "readonly", (store) => store.getAll());
        const metas: StudioSavedProjectMeta[] = [];
        for (const item of all || []) {
          const check = validateStudioProject(item);
          if (check.ok) metas.push(summarizeProjectMeta(check.project));
        }
        metas.sort((a, b) => b.savedAt - a.savedAt);
        return { ok: true, data: metas };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    },

    async deleteProject(id: string): Promise<StorageResult<void>> {
      try {
        await runTx(STORE_PROJECTS, "readwrite", (store) => store.delete(id));
        return { ok: true, data: undefined };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    },

    async saveAutosave(project: StudioProjectData): Promise<StorageResult<number>> {
      const check = validateStudioProject(project);
      if (!check.ok) {
        return { ok: false, kind: "corrupt", message: check.error };
      }
      const updatedAt = Date.now();
      const rec: AutosaveRecord = {
        slot: AUTOSAVE_SLOT,
        updatedAt,
        project: { ...check.project, savedAt: updatedAt }
      };
      try {
        await runTx(STORE_AUTOSAVE, "readwrite", (store) => store.put(rec));
        return { ok: true, data: updatedAt };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    },

    async loadAutosave(): Promise<StorageResult<{ project: StudioProjectData; updatedAt: number } | null>> {
      try {
        const raw = await runTx<AutosaveRecord | undefined>(STORE_AUTOSAVE, "readonly", (store) =>
          store.get(AUTOSAVE_SLOT)
        );
        if (!raw || !raw.project) return { ok: true, data: null };
        const check = validateStudioProject(raw.project);
        if (!check.ok) {
          return { ok: false, kind: "corrupt", message: `Autosave recovery data is corrupted: ${check.error}` };
        }
        return {
          ok: true,
          data: {
            project: check.project,
            updatedAt: Number(raw.updatedAt) || check.project.savedAt
          }
        };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    },

    async clearAutosave(): Promise<StorageResult<void>> {
      try {
        await runTx(STORE_AUTOSAVE, "readwrite", (store) => store.delete(AUTOSAVE_SLOT));
        return { ok: true, data: undefined };
      } catch (err) {
        const c = classifyStorageError(err);
        return { ok: false, kind: c.kind, message: c.message };
      }
    }
  };
}

export const studioStorage = createStudioStorage();
