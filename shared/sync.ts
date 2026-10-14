// Two-way vault sync with a private GitHub repository over the GitHub REST API.
// Works the same in the desktop app (Node) and the web app (browser): fetch + Web Crypto only.
//
// Each sync compares three states per file, using git blob hashes:
//   base   = what both sides had after the last successful sync
//   local  = what this device has now
//   remote = what the repository has now
// and then pulls remote changes, pushes local changes in one commit, and keeps both versions
// when the same file changed on both sides (the local one is saved as a "konflikt" copy).
import { basename, dirname, isoDate, joinPath } from "./markdown";
import { isIgnoredPath, isNotePath, type Vault } from "./vault";

export interface SyncConfig {
  owner: string;
  repo: string;
  branch?: string;
  token: string;
  /** Shown in commit messages, e.g. "počítač" or "iPhone". */
  device: string;
  /** Override for tests. */
  apiBase?: string;
}

export interface SyncResult {
  pulled: string[];
  pushed: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
  commit?: string;
}

interface SyncState {
  repo: string;
  base: Record<string, string>;
}

const STATE_FILE = "sync.json";
const MARKER = ".vimmi-sync";

export class SyncError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// ---------- encoding helpers ----------

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The git blob hash of some bytes: sha1("blob <len>\0" + bytes). */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- GitHub API ----------

class GitHub {
  constructor(private cfg: SyncConfig) {}

  private get base() {
    return (this.cfg.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  }

  async req<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.cfg.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new SyncError("Nepodařilo se spojit s GitHubem. Jsi připojený k internetu?");
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : (undefined as T);
    if (!res.ok && !allow.includes(res.status)) {
      const msg = (data as { message?: string } | undefined)?.message ?? res.statusText;
      if (res.status === 401) throw new SyncError("GitHub token je neplatný nebo vypršel.", 401);
      if (res.status === 403 && /rate limit/i.test(msg)) throw new SyncError("GitHub dočasně omezil počet požadavků. Zkus to za chvíli.", 403);
      if (res.status === 403) throw new SyncError("GitHub token nemá oprávnění k zápisu do repozitáře (Contents: Read and write).", 403);
      if (res.status === 404) throw new SyncError(`Repozitář ${this.cfg.owner}/${this.cfg.repo} nebyl nalezen, nebo k němu token nemá přístup.`, 404);
      throw new SyncError(`GitHub: ${msg}`, res.status);
    }
    return { status: res.status, data };
  }

  repoPath(rest = "") {
    return `/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}${rest}`;
  }
}

/** Who owns the token, for filling in the repository owner. */
export async function githubUser(token: string, apiBase?: string): Promise<string> {
  const gh = new GitHub({ owner: "", repo: "", token, device: "", apiBase });
  const { data } = await gh.req<{ login: string }>("GET", "/user");
  return data.login;
}

/** Creates a private repository for the notes. */
export async function createPrivateRepo(token: string, name: string, apiBase?: string): Promise<{ owner: string; repo: string }> {
  const gh = new GitHub({ owner: "", repo: "", token, device: "", apiBase });
  const { status, data } = await gh.req<{ name: string; owner: { login: string }; message?: string }>(
    "POST",
    "/user/repos",
    { name, private: true, description: "Poznámky z aplikace Vimmi", auto_init: false },
    [403, 404, 422],
  );
  if (status === 422) throw new SyncError(`Repozitář „${name}“ už existuje – zadej ho do pole Repozitář.`, 422);
  if (status === 403 || status === 404) {
    throw new SyncError("Token nemůže zakládat repozitáře. Vytvoř repozitář ručně na github.com/new (soukromý) a zadej jeho název.", status);
  }
  return { owner: data.owner.login, repo: data.name };
}

// ---------- sync ----------

interface RemoteTree {
  commit: string | null;
  tree: string | null;
  files: Record<string, string>;
}

async function remoteTree(gh: GitHub, branch: string): Promise<RemoteTree> {
  const ref = await gh.req<{ object: { sha: string } }>("GET", gh.repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`), undefined, [404, 409]);
  if (ref.status === 404 || ref.status === 409) return { commit: null, tree: null, files: {} };
  const commit = ref.data.object.sha;
  const c = await gh.req<{ tree: { sha: string } }>("GET", gh.repoPath(`/git/commits/${commit}`));
  const t = await gh.req<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
    "GET",
    gh.repoPath(`/git/trees/${c.data.tree.sha}?recursive=1`),
  );
  if (t.data.truncated) throw new SyncError("Repozitář je příliš velký pro synchronizaci najednou.");
  const files: Record<string, string> = {};
  for (const e of t.data.tree) if (e.type === "blob" && !isIgnoredPath(e.path)) files[e.path] = e.sha;
  return { commit, tree: c.data.tree.sha, files };
}

/** An empty repository has no branch yet; the Git data API needs one, so create it with a marker file. */
async function initRepo(gh: GitHub, branch: string): Promise<void> {
  await gh.req("PUT", gh.repoPath(`/contents/${MARKER}`), {
    message: "Vimmi: založení synchronizace",
    content: toBase64(encoder.encode("Tento repozitář synchronizuje poznámky z aplikace Vimmi.\n")),
    branch,
  });
}

function conflictPath(path: string, device: string): string {
  const name = basename(path);
  const ext = isNotePath(path) ? ".md" : (path.match(/(\.[^./]+)$/)?.[1] ?? "");
  const stem = isNotePath(path) ? name : name.replace(/\.[^.]+$/, "");
  return joinPath(dirname(path), `${stem} (konflikt ${device} ${isoDate()})${ext}`);
}

async function loadState(vault: Vault): Promise<SyncState | null> {
  try {
    const raw = await vault.storage.readPrivate(STATE_FILE);
    return raw ? (JSON.parse(raw) as SyncState) : null;
  } catch {
    return null;
  }
}

export async function forgetSyncState(vault: Vault): Promise<void> {
  await vault.storage.writePrivate(STATE_FILE, "");
}

/** Runs one full two-way sync. Safe to call repeatedly; does nothing when everything matches. */
export async function syncVault(vault: Vault, cfg: SyncConfig): Promise<SyncResult> {
  const gh = new GitHub(cfg);
  const repoId = `${cfg.owner}/${cfg.repo}`.toLowerCase();
  let branch = cfg.branch;
  if (!branch) {
    const info = await gh.req<{ default_branch: string }>("GET", gh.repoPath());
    branch = info.data.default_branch || "main";
  }
  const state = await loadState(vault);
  // A different repository than last time starts from scratch (nothing is deleted on first sync).
  const base: Record<string, string> = state && state.repo === repoId ? state.base : {};

  for (let attempt = 0; attempt < 3; attempt++) {
    let remote = await remoteTree(gh, branch);
    if (!remote.commit) {
      await initRepo(gh, branch);
      remote = await remoteTree(gh, branch);
    }

    const local: Record<string, string> = {};
    const localBytes = new Map<string, Uint8Array>();
    for (const f of vault.allFiles()) {
      const bytes = await vault.readBytes(f.path);
      localBytes.set(f.path, bytes);
      local[f.path] = await gitBlobSha(bytes);
    }

    const result: SyncResult = { pulled: [], pushed: [], deletedLocal: [], deletedRemote: [], conflicts: [] };
    const pulls: [string, string][] = [];
    const pushes: string[] = [];
    const remoteDeletes: string[] = [];
    const localDeletes: string[] = [];
    const conflictCopies: [string, Uint8Array][] = [];
    const nextBase: Record<string, string> = {};

    const paths = new Set([...Object.keys(local), ...Object.keys(remote.files), ...Object.keys(base)]);
    for (const p of paths) {
      const l = local[p];
      const r = remote.files[p];
      const b = base[p];
      if (l === r) {
        if (l) nextBase[p] = l;
      } else if (l === b) {
        // Only the remote side changed.
        if (r) pulls.push([p, r]);
        else localDeletes.push(p);
      } else if (r === b) {
        // Only this device changed.
        if (l) pushes.push(p);
        else remoteDeletes.push(p);
      } else if (!l) {
        // Deleted here, edited there: keep the edit.
        pulls.push([p, r!]);
      } else if (!r) {
        // Edited here, deleted there: keep the edit.
        pushes.push(p);
      } else {
        // Changed on both sides: take the remote version and keep ours next to it.
        pulls.push([p, r]);
        const copy = conflictPath(p, cfg.device);
        conflictCopies.push([copy, localBytes.get(p)!]);
        result.conflicts.push(copy);
      }
    }

    // Pull: download blobs and write them locally.
    for (const [p, sha] of pulls) {
      const blob = await gh.req<{ content: string; encoding: string }>("GET", gh.repoPath(`/git/blobs/${sha}`));
      const bytes = blob.data.encoding === "base64" ? fromBase64(blob.data.content) : encoder.encode(blob.data.content);
      await vault.writeSynced(p, bytes);
      nextBase[p] = sha;
      result.pulled.push(p);
    }
    for (const p of localDeletes) {
      await vault.trash(p).catch(() => {});
      result.deletedLocal.push(p);
    }
    for (const [p, bytes] of conflictCopies) {
      await vault.writeSynced(p, bytes);
      pushes.push(p);
      local[p] = await gitBlobSha(bytes);
      localBytes.set(p, bytes);
    }

    // Push: one commit with all local changes.
    if (pushes.length || remoteDeletes.length) {
      const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
      for (const p of pushes) {
        const blob = await gh.req<{ sha: string }>("POST", gh.repoPath("/git/blobs"), {
          content: toBase64(localBytes.get(p)!),
          encoding: "base64",
        });
        entries.push({ path: p, mode: "100644", type: "blob", sha: blob.data.sha });
        nextBase[p] = blob.data.sha;
      }
      for (const p of remoteDeletes) entries.push({ path: p, mode: "100644", type: "blob", sha: null });
      const tree = await gh.req<{ sha: string }>("POST", gh.repoPath("/git/trees"), { base_tree: remote.tree, tree: entries });
      const n = pushes.length + remoteDeletes.length;
      const commit = await gh.req<{ sha: string }>("POST", gh.repoPath("/git/commits"), {
        message: `Vimmi (${cfg.device}): ${n} ${n === 1 ? "změna" : n < 5 ? "změny" : "změn"}`,
        tree: tree.data.sha,
        parents: [remote.commit],
      });
      const update = await gh.req("PATCH", gh.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`), { sha: commit.data.sha, force: false }, [409, 422]);
      if (update.status === 409 || update.status === 422) {
        // Someone else pushed in the meantime: save what we pulled and try again.
        await vault.storage.writePrivate(STATE_FILE, JSON.stringify({ repo: repoId, base: { ...base, ...pickPulled(nextBase, result.pulled) } }));
        Object.assign(base, pickPulled(nextBase, result.pulled));
        continue;
      }
      result.commit = commit.data.sha;
      result.pushed = pushes;
      result.deletedRemote = remoteDeletes;
    }

    await vault.storage.writePrivate(STATE_FILE, JSON.stringify({ repo: repoId, base: nextBase } satisfies SyncState));
    return result;
  }
  throw new SyncError("Synchronizace se nepodařila – repozitář se mezitím změnil. Zkus to znovu.");
}

function pickPulled(base: Record<string, string>, pulled: string[]): Record<string, string> {
  return Object.fromEntries(pulled.filter((p) => base[p]).map((p) => [p, base[p]]));
}
