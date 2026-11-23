// Vault storage for the Rust desktop app: every call goes to the Rust side (src-tauri/src/vault.rs),
// which keeps all paths inside the open vault folder.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileStat, VaultStorage } from "../shared/vault";

export class TauriStorage implements VaultStorage {
  /** Content we wrote ourselves, so the watcher can ignore the echo. */
  private ownWrites = new Map<string, number>();

  constructor(
    readonly root: string,
    readonly name: string,
  ) {}

  /** Opens the folder on the Rust side and returns a storage for it. */
  static async open(dir: string): Promise<TauriStorage> {
    const root = await invoke<string>("vault_open", { dir });
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    return new TauriStorage(root, name);
  }

  private mark(...rels: string[]) {
    const now = Date.now();
    for (const r of rels) this.ownWrites.set(r, now);
  }

  list() {
    return invoke<{ folders: string[]; files: (FileStat & { path: string })[] }>("fs_list");
  }

  readText(rel: string) {
    return invoke<string>("fs_read_text", { rel });
  }

  async readBytes(rel: string) {
    return new Uint8Array(await invoke<ArrayBuffer>("fs_read_bytes", { rel }));
  }

  writeText(rel: string, content: string) {
    this.mark(rel);
    return invoke<FileStat>("fs_write_text", { rel, content });
  }

  writeBytes(rel: string, data: Uint8Array) {
    this.mark(rel);
    return invoke<FileStat>("fs_write_bytes", data, { headers: { "x-vimmi-path": encodeURIComponent(rel) } });
  }

  stat(rel: string) {
    return invoke<FileStat | null>("fs_stat", { rel });
  }

  mkdir(rel: string) {
    return invoke<void>("fs_mkdir", { rel });
  }

  rename(from: string, to: string) {
    this.mark(from, to);
    return invoke<void>("fs_rename", { from, to });
  }

  trash(rel: string) {
    this.mark(rel);
    return invoke<void>("fs_trash", { rel });
  }

  watch(onChange: (rel: string) => void) {
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    let stop: (() => void) | undefined;
    let closed = false;
    void listen<string>("vault-fs", (e) => {
      const rel = e.payload;
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
    }).then((unlisten) => {
      if (closed) unlisten();
      else stop = unlisten;
    });
    return () => {
      closed = true;
      stop?.();
      for (const t of pending.values()) clearTimeout(t);
    };
  }

  async readPrivate(name: string) {
    return invoke<string | null>("private_read", { name });
  }

  writePrivate(name: string, content: string) {
    return invoke<void>("private_write", { name, content });
  }

  deletePrivate(name: string) {
    return invoke<void>("private_delete", { name });
  }

  listPrivate(dir: string) {
    return invoke<string[]>("private_list", { dir });
  }
}
