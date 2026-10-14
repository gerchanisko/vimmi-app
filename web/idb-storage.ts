// Vault storage in the browser (IndexedDB). Notes are text, attachments are Blobs.
import type { FileStat, VaultStorage } from "../shared/vault";

interface FileRecord {
  path: string;
  text?: string;
  blob?: Blob;
  mtime: number;
  ctime: number;
}

const DB_NAME = "vimmi";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders");
      if (!db.objectStoreNames.contains("private")) db.createObjectStore("private");
      if (!db.objectStoreNames.contains("trash")) db.createObjectStore("trash", { autoIncrement: true });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** Simple key-value access to one object store. */
export async function kvGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return req(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function kvSet(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  await req(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

export async function kvDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  await req(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export class IdbStorage implements VaultStorage {
  readonly root = "browser";
  readonly name = "Moje poznámky";
  private files = new Map<string, FileRecord>();
  private folders = new Set<string>();
  private urls = new Map<string, string>();

  constructor(private db: IDBDatabase) {}

  /** Loads everything into memory; call once before use. */
  async init(): Promise<void> {
    const files = (await req(this.db.transaction("files").objectStore("files").getAll())) as FileRecord[];
    this.files = new Map(files.map((f) => [f.path, f]));
    this.folders = new Set((await req(this.db.transaction("folders").objectStore("folders").getAllKeys())) as string[]);
  }

  isEmpty(): boolean {
    return this.files.size === 0;
  }

  private statOf(rec: FileRecord): FileStat {
    return { mtime: rec.mtime, ctime: rec.ctime };
  }

  private async put(rec: FileRecord): Promise<FileStat> {
    this.files.set(rec.path, rec);
    const old = this.urls.get(rec.path);
    if (old) {
      URL.revokeObjectURL(old);
      this.urls.delete(rec.path);
    }
    await req(this.db.transaction("files", "readwrite").objectStore("files").put(rec));
    return this.statOf(rec);
  }

  async list() {
    return { folders: [...this.folders], files: [...this.files.values()].map((f) => ({ path: f.path, ...this.statOf(f) })) };
  }

  async readText(rel: string) {
    const f = this.files.get(rel);
    if (!f) throw new Error(`Soubor neexistuje: ${rel}`);
    return f.text ?? (await f.blob!.text());
  }

  async readBytes(rel: string) {
    const f = this.files.get(rel);
    if (!f) throw new Error(`Soubor neexistuje: ${rel}`);
    return f.text !== undefined ? new TextEncoder().encode(f.text) : new Uint8Array(await f.blob!.arrayBuffer());
  }

  writeText(rel: string, text: string) {
    const now = Date.now();
    return this.put({ path: rel, text, mtime: now, ctime: this.files.get(rel)?.ctime ?? now });
  }

  writeBytes(rel: string, data: Uint8Array) {
    const now = Date.now();
    const type = /\.png$/i.test(rel) ? "image/png" : /\.jpe?g$/i.test(rel) ? "image/jpeg" : /\.gif$/i.test(rel) ? "image/gif" : /\.webp$/i.test(rel) ? "image/webp" : /\.svg$/i.test(rel) ? "image/svg+xml" : "application/octet-stream";
    return this.put({ path: rel, blob: new Blob([data as BlobPart], { type }), mtime: now, ctime: this.files.get(rel)?.ctime ?? now });
  }

  async stat(rel: string) {
    const f = this.files.get(rel);
    if (f) return this.statOf(f);
    return this.folders.has(rel) ? { mtime: 0, ctime: 0, dir: true } : null;
  }

  async mkdir(rel: string) {
    this.folders.add(rel);
    await kvSet(this.db, "folders", rel, true);
  }

  async rename(from: string, to: string) {
    const moves = [...this.files.keys()].filter((p) => p === from || p.startsWith(from + "/"));
    for (const p of moves) {
      const rec = this.files.get(p)!;
      const next = to + p.slice(from.length);
      this.files.delete(p);
      await req(this.db.transaction("files", "readwrite").objectStore("files").delete(p));
      await this.put({ ...rec, path: next });
    }
    for (const f of [...this.folders]) {
      if (f === from || f.startsWith(from + "/")) {
        this.folders.delete(f);
        await kvDelete(this.db, "folders", f);
        await this.mkdir(to + f.slice(from.length));
      }
    }
  }

  async trash(rel: string) {
    const victims = [...this.files.keys()].filter((p) => p === rel || p.startsWith(rel + "/"));
    for (const p of victims) {
      const rec = this.files.get(p)!;
      await req(this.db.transaction("trash", "readwrite").objectStore("trash").add({ ...rec, trashedAt: Date.now() }));
      await req(this.db.transaction("files", "readwrite").objectStore("files").delete(p));
      this.files.delete(p);
    }
    for (const f of [...this.folders]) {
      if (f === rel || f.startsWith(rel + "/")) {
        this.folders.delete(f);
        await kvDelete(this.db, "folders", f);
      }
    }
  }

  async readPrivate(name: string) {
    return (await kvGet<string>(this.db, "private", name)) ?? null;
  }

  async writePrivate(name: string, content: string) {
    await kvSet(this.db, "private", name, content);
  }

  async deletePrivate(name: string) {
    await kvDelete(this.db, "private", name);
  }

  async listPrivate(dir: string) {
    const keys = (await req(this.db.transaction("private").objectStore("private").getAllKeys())) as string[];
    return keys.filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1));
  }

  /** Object URL for showing an attachment (cached). */
  fileUrl(rel: string): string {
    const cached = this.urls.get(rel);
    if (cached) return cached;
    const f = this.files.get(rel);
    if (!f?.blob) return "";
    const url = URL.createObjectURL(f.blob);
    this.urls.set(rel, url);
    return url;
  }
}
