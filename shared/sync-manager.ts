// Runs vault sync automatically: on start, every 15 s, when the app comes back and on demand.
// A tick with no local changes is a quick check (one GitHub request); a full comparison runs when
// something changed here or on GitHub, and every few minutes as a safety net.
import { Emitter } from "./emitter";
import { syncVault, type SyncConfig } from "./sync";
import type { SyncStatus } from "./types";
import type { Vault } from "./vault";

const INTERVAL_MS = 15_000;
/** While typing, wait for a short pause before sending (but never longer than MAX_DIRTY_MS). */
const TYPING_PAUSE_MS = 4_000;
const MAX_DIRTY_MS = 60_000;
/** Full comparison at least this often (catches anything the change events missed). */
const FULL_EVERY_MS = 5 * 60_000;

export class SyncManager extends Emitter {
  status: SyncStatus = { state: "off" };
  private running: Promise<void> | null = null;
  private again = false;
  private interval?: ReturnType<typeof setInterval>;
  /** Local changes not yet sent: time of the first and the last one. */
  private dirtySince = 0;
  private lastEdit = 0;
  private lastFull = 0;
  /** Paths changed outside the editor while a sync was running (pulled files, or AI/disk edits). */
  private changedDuringSync = new Set<string>();
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
      // During a sync, external changes are usually files it pulled; sort that out afterwards.
      if (this.running && e.external) this.changedDuringSync.add(e.path);
      else this.markDirty();
    });
    this.interval = setInterval(() => void this.tick(), INTERVAL_MS);
    void this.syncNow();
  }

  stop(): void {
    this.unsubscribe?.();
    clearInterval(this.interval);
  }

  private markDirty(): void {
    const now = Date.now();
    if (!this.dirtySince) this.dirtySince = now;
    this.lastEdit = now;
  }

  /** Periodic run: quick check when nothing changed here, full sync after a pause in typing. */
  private async tick(): Promise<void> {
    if (this.running) return;
    const now = Date.now();
    if (this.dirtySince) {
      const typing = now - this.lastEdit < TYPING_PAUSE_MS && now - this.dirtySince < MAX_DIRTY_MS;
      if (!typing) await this.syncNow();
      return;
    }
    await this.syncNow({ quick: now - this.lastFull < FULL_EVERY_MS });
  }

  /**
   * Syncs now; if a sync is already running, runs once more after it.
   * `quick` only checks GitHub for new commits, unless something changed locally.
   */
  async syncNow(opts: { quick?: boolean } = {}): Promise<SyncStatus> {
    if (this.running) {
      if (!opts.quick) this.again = true;
      await this.running;
      return this.status;
    }
    const vault = this.getVault();
    const cfg = this.getConfig();
    if (!vault || !cfg) {
      this.setStatus({ state: "off" });
      return this.status;
    }
    const quick = Boolean(opts.quick) && !this.dirtySince;
    // Changes made from now on belong to the next sync.
    const wasDirty = { since: this.dirtySince, last: this.lastEdit };
    this.dirtySince = 0;
    this.changedDuringSync.clear();
    if (!quick) this.setStatus({ state: "syncing" });
    this.running = (async () => {
      try {
        const r = await syncVault(vault, cfg, { quick });
        if (!r.unchanged) this.lastFull = Date.now();
        const written = new Set([...r.pulled, ...r.deletedLocal, ...r.conflicts]);
        if ([...this.changedDuringSync].some((p) => !written.has(p))) this.markDirty();
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
        // Nothing was sent: keep the local changes for the next attempt.
        if (wasDirty.since) {
          this.dirtySince = this.dirtySince ? Math.min(this.dirtySince, wasDirty.since) : wasDirty.since;
          this.lastEdit = Math.max(this.lastEdit, wasDirty.last);
        }
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
