// Vault storage on the local disk (desktop app).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { cleanPath, isIgnoredPath, VaultError, type FileStat, type VaultStorage } from "../shared/vault";

export class NodeStorage implements VaultStorage {
  readonly root: string;
  readonly name: string;
  /** Content we wrote ourselves, so the watcher can ignore the echo. */
  private ownWrites = new Map<string, number>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.name = path.basename(this.root);
  }

  /** Converts a vault-relative path to an absolute one, refusing anything outside the vault. */
  abs(rel: string): string {
    const full = path.resolve(this.root, cleanPath(rel));
    const relative = path.relative(this.root, full);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      throw new VaultError(`Cesta je mimo trezor: ${rel}`);
    }
    return full;
  }

  private rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  private toStat(s: fs.Stats): FileStat {
    return { mtime: s.mtimeMs, ctime: s.birthtimeMs || s.ctimeMs, dir: s.isDirectory() || undefined };
  }

  async list() {
    await fsp.mkdir(this.root, { recursive: true });
    const folders: string[] = [];
    const files: (FileStat & { path: string })[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async (e) => {
          const full = path.join(dir, e.name);
          const rel = this.rel(full);
          if (isIgnoredPath(rel)) return;
          if (e.isDirectory()) {
            folders.push(rel);
            await walk(full);
          } else if (e.isFile()) {
            const st = await fsp.stat(full).catch(() => null);
            if (st) files.push({ path: rel, ...this.toStat(st) });
          }
        }),
      );
    };
    await walk(this.root);
    return { folders, files };
  }

  readText(rel: string) {
    return fsp.readFile(this.abs(rel), "utf8");
  }

  async readBytes(rel: string) {
    return new Uint8Array(await fsp.readFile(this.abs(rel)));
  }

  private async atomicWrite(rel: string, data: string | Uint8Array): Promise<FileStat> {
    const full = this.abs(rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.tmp`);
    this.ownWrites.set(rel, Date.now());
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, full);
    return this.toStat(await fsp.stat(full));
  }

  writeText(rel: string, content: string) {
    return this.atomicWrite(rel, content);
  }

  writeBytes(rel: string, data: Uint8Array) {
    return this.atomicWrite(rel, data);
  }

  async stat(rel: string) {
    const s = await fsp.stat(this.abs(rel)).catch(() => null);
    return s ? this.toStat(s) : null;
  }

  async mkdir(rel: string) {
    await fsp.mkdir(this.abs(rel), { recursive: true });
  }

  async rename(from: string, to: string) {
    await fsp.mkdir(path.dirname(this.abs(to)), { recursive: true });
    this.ownWrites.set(from, Date.now());
    this.ownWrites.set(to, Date.now());
    await fsp.rename(this.abs(from), this.abs(to));
  }

  async trash(rel: string) {
    const full = this.abs(rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(this.root, ".trash", `${stamp} ${path.basename(full)}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    this.ownWrites.set(rel, Date.now());
    await fsp.rename(full, dest);
  }

  watch(onChange: (rel: string) => void) {
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/");
        if (isIgnoredPath(rel) || rel.endsWith(".tmp")) return;
        clearTimeout(pending.get(rel));
        pending.set(
          rel,
          setTimeout(() => {
            pending.delete(rel);
            // Echoes of our own writes arrive within a moment; the vault also ignores unchanged content.
            const own = this.ownWrites.get(rel);
            if (own && Date.now() - own < 1500) return;
            onChange(rel);
          }, 150),
        );
      });
    } catch {
      // Recursive watching is not available everywhere; the app still works without live outside edits.
    }
    return () => {
      watcher?.close();
      for (const t of pending.values()) clearTimeout(t);
    };
  }

  private privatePath(name: string) {
    return path.join(this.root, ".vimmi", name);
  }

  async readPrivate(name: string) {
    return fsp.readFile(this.privatePath(name), "utf8").catch(() => null);
  }

  async writePrivate(name: string, content: string) {
    await fsp.mkdir(path.dirname(this.privatePath(name)), { recursive: true });
    await fsp.writeFile(this.privatePath(name), content);
  }

  async deletePrivate(name: string) {
    await fsp.rm(this.privatePath(name), { force: true });
  }

  async listPrivate(dir: string) {
    return fsp.readdir(this.privatePath(dir)).catch(() => [] as string[]);
  }
}
