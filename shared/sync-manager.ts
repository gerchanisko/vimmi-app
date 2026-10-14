// Runs vault sync automatically: on start, shortly after local edits, periodically and on demand.
import { Emitter } from "./emitter";
import { syncVault, type SyncConfig } from "./sync";
import type { SyncStatus } from "./types";
import type { Vault } from "./vault";

const AFTER_EDIT_MS = 15_000;
const INTERVAL_MS = 120_000;

export class SyncManager extends Emitter {
  status: SyncStatus = { state: "off" };
  private running: Promise<void> | null = null;
  private again = false;
  private editTimer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;

  constructor(
    private getVault: () => Vault | undefined,
    private getConfig: () => SyncConfig | null,
  ) {
    super();
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  /** (Re)starts automatic sync for the current vault and config. */
  restart(): void {
    this.stop();
    const vault = this.getVault();
    if (!vault || !this.getConfig()) {
      this.setStatus({ state: "off", message: undefined });
      return;
    }
    this.setStatus({ state: "idle", message: undefined });
    this.unsubscribe = vault.on<{ path: string; external: boolean }>("note-changed", (e) => {
      if (e.external) return; // pulled by sync or edited on disk: nothing to send
      clearTimeout(this.editTimer);
      this.editTimer = setTimeout(() => void this.syncNow(), AFTER_EDIT_MS);
    });
    this.interval = setInterval(() => void this.syncNow(), INTERVAL_MS);
    void this.syncNow();
  }

  stop(): void {
    this.unsubscribe?.();
    clearTimeout(this.editTimer);
    clearInterval(this.interval);
  }

  /** Syncs now; if a sync is already running, runs once more after it. */
  async syncNow(): Promise<SyncStatus> {
    if (this.running) {
      this.again = true;
      await this.running;
      return this.status;
    }
    const vault = this.getVault();
    const cfg = this.getConfig();
    if (!vault || !cfg) {
      this.setStatus({ state: "off" });
      return this.status;
    }
    clearTimeout(this.editTimer);
    this.setStatus({ state: "syncing" });
    this.running = (async () => {
      try {
        const r = await syncVault(vault, cfg);
        const changed = r.pulled.length + r.pushed.length + r.deletedLocal.length + r.deletedRemote.length;
        this.setStatus({
          state: "idle",
          lastSync: Date.now(),
          message: undefined,
          ...(changed
            ? {
                lastChange: {
                  pulled: r.pulled.length,
                  pushed: r.pushed.length,
                  deleted: r.deletedLocal.length + r.deletedRemote.length,
                  conflicts: r.conflicts,
                  at: Date.now(),
                },
              }
            : {}),
        });
        if (r.conflicts.length) this.emit("conflicts", r.conflicts);
      } catch (err) {
        this.setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    await this.running;
    this.running = null;
    if (this.again) {
      this.again = false;
      return this.syncNow();
    }
    return this.status;
  }
}
