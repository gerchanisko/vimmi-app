// In-memory VaultStorage for unit tests.
import type { FileStat, VaultStorage } from "../shared/vault";

export class MemoryStorage implements VaultStorage {
  root = "mem";
  name = "Paměť";
  files = new Map<string, { data: Uint8Array; stat: FileStat }>();
  folders = new Set<string>();
  trashed: string[] = [];
  private priv = new Map<string, string>();

  async list() {
    return { folders: [...this.folders], files: [...this.files].map(([path, f]) => ({ path, ...f.stat })) };
  }
  async readText(rel: string) {
    return new TextDecoder().decode(this.files.get(rel)!.data);
  }
  async readBytes(rel: string) {
    return this.files.get(rel)!.data;
  }
  async writeText(rel: string, content: string) {
    return this.writeBytes(rel, new TextEncoder().encode(content));
  }
  async writeBytes(rel: string, data: Uint8Array) {
    const stat = { mtime: Date.now(), ctime: Date.now() };
    this.files.set(rel, { data, stat });
    return stat;
  }
  async stat(rel: string) {
    return this.files.get(rel)?.stat ?? (this.folders.has(rel) ? { mtime: 0, ctime: 0, dir: true } : null);
  }
  async mkdir(rel: string) {
    this.folders.add(rel);
  }
  async rename(from: string, to: string) {
    const f = this.files.get(from)!;
    this.files.delete(from);
    this.files.set(to, f);
  }
  async trash(rel: string) {
    this.files.delete(rel);
    this.trashed.push(rel);
  }
  async readPrivate(name: string) {
    return this.priv.get(name) ?? null;
  }
  async writePrivate(name: string, content: string) {
    this.priv.set(name, content);
  }
  async deletePrivate(name: string) {
    this.priv.delete(name);
  }
  async listPrivate(dir: string) {
    return [...this.priv.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1));
  }
}
