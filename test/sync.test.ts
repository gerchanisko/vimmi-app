// Sync tests: two devices sync through an in-memory fake of the GitHub git data API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncVault, type SyncConfig } from "../shared/sync";
import { FakeGitHub } from "./fake-github";
import { Vault } from "../shared/vault";
import { MemoryStorage } from "./memory-storage";

// ---------- tests ----------

let gh: FakeGitHub;
const realFetch = globalThis.fetch;
const cfg = (device: string): SyncConfig => ({ owner: "me", repo: "notes", token: "t", device, apiBase: "https://gh.test" });

async function device(files: Record<string, string> = {}) {
  const storage = new MemoryStorage();
  for (const [p, text] of Object.entries(files)) await storage.writeText(p, text);
  const vault = new Vault(storage);
  await vault.load();
  return { vault, storage };
}

beforeEach(() => {
  gh = new FakeGitHub();
  globalThis.fetch = gh.fetch as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("sync", () => {
  it("uploads a vault to an empty repository and downloads it on another device", async () => {
    const pc = await device({ "Nápady.md": "# Nápady\n- [ ] úkol", "Projekty/Web.md": "# Web" });
    const r1 = await syncVault(pc.vault, cfg("počítač"));
    expect(r1.pushed.sort()).toEqual(["Nápady.md", "Projekty/Web.md"]);
    expect(gh.snapshot()["Nápady.md"]).toBe("# Nápady\n- [ ] úkol");

    const phone = await device();
    const r2 = await syncVault(phone.vault, cfg("iPhone"));
    expect(r2.pulled.sort()).toEqual(["Nápady.md", "Projekty/Web.md"]);
    expect(phone.vault.read("Projekty/Web.md")).toBe("# Web");
    expect(phone.vault.allTasks()).toHaveLength(1);
  });

  it("does nothing when both sides match", async () => {
    const pc = await device({ "A.md": "a" });
    await syncVault(pc.vault, cfg("pc"));
    const before = gh.ref;
    const r = await syncVault(pc.vault, cfg("pc"));
    expect(r).toMatchObject({ pulled: [], pushed: [], conflicts: [] });
    expect(gh.ref).toBe(before);
  });

  it("quick check costs one request when nothing changed and still notices new commits", async () => {
    const pc = await device({ "A.md": "a", "Přílohy/foto.png": "\u0089PNG obrázek" });
    await syncVault(pc.vault, cfg("pc"));
    const phone = await device();
    await syncVault(phone.vault, cfg("phone"));
    expect(phone.vault.snapshot().files).toContain("Přílohy/foto.png");

    const before = gh.requests;
    const idle = await syncVault(phone.vault, cfg("phone"), { quick: true });
    expect(idle.unchanged).toBe(true);
    expect(gh.requests - before).toBe(1);

    await pc.vault.write("A.md", "a z počítače");
    await syncVault(pc.vault, cfg("pc"));
    const r = await syncVault(phone.vault, cfg("phone"), { quick: true });
    expect(r.unchanged).toBeFalsy();
    expect(r.pulled).toEqual(["A.md"]);
    expect(phone.vault.read("A.md")).toBe("a z počítače");
  });

  it("carries edits and deletions both ways", async () => {
    const pc = await device({ "A.md": "a", "B.md": "b" });
    await syncVault(pc.vault, cfg("pc"));
    const phone = await device();
    await syncVault(phone.vault, cfg("phone"));

    await phone.vault.write("A.md", "a z telefonu");
    await phone.vault.trash("B.md");
    await phone.vault.create("Nová", "# Nová");
    const r1 = await syncVault(phone.vault, cfg("phone"));
    expect(r1.pushed.sort()).toEqual(["A.md", "Nová.md"]);
    expect(r1.deletedRemote).toEqual(["B.md"]);

    const r2 = await syncVault(pc.vault, cfg("pc"));
    expect(r2.pulled.sort()).toEqual(["A.md", "Nová.md"]);
    expect(r2.deletedLocal).toEqual(["B.md"]);
    expect(pc.vault.read("A.md")).toBe("a z telefonu");
    expect(pc.vault.has("B.md")).toBe(false);
    expect(pc.storage.trashed).toContain("B.md");
  });

  it("keeps both versions on a conflict", async () => {
    const pc = await device({ "A.md": "původní" });
    await syncVault(pc.vault, cfg("pc"));
    const phone = await device();
    await syncVault(phone.vault, cfg("iPhone"));

    await pc.vault.write("A.md", "verze z počítače");
    await phone.vault.write("A.md", "verze z telefonu");
    await syncVault(pc.vault, cfg("pc"));
    const r = await syncVault(phone.vault, cfg("iPhone"));

    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatch(/^A \(konflikt iPhone \d{4}-\d{2}-\d{2}\)\.md$/);
    expect(phone.vault.read("A.md")).toBe("verze z počítače");
    expect(phone.vault.read(r.conflicts[0])).toBe("verze z telefonu");

    await syncVault(pc.vault, cfg("pc"));
    expect(pc.vault.read(r.conflicts[0])).toBe("verze z telefonu");
    expect(Object.keys(gh.snapshot()).sort()).toEqual([".vimmi-sync", "A.md", r.conflicts[0]].sort());
  });

  it("keeps an edit when the other side deleted the note", async () => {
    const pc = await device({ "A.md": "a" });
    await syncVault(pc.vault, cfg("pc"));
    const phone = await device();
    await syncVault(phone.vault, cfg("phone"));
    await pc.vault.trash("A.md");
    await syncVault(pc.vault, cfg("pc"));
    await phone.vault.write("A.md", "upraveno");
    await syncVault(phone.vault, cfg("phone"));
    await syncVault(pc.vault, cfg("pc"));
    expect(pc.vault.read("A.md")).toBe("upraveno");
  });

  it("syncs binary attachments byte for byte", async () => {
    const pc = await device({ "A.md": "![](Přílohy/foto.png)" });
    const png = new Uint8Array([137, 80, 78, 71, 0, 255, 10, 13, 0, 1, 2, 3]);
    await pc.vault.saveAttachment("foto.png", png, "Přílohy");
    await syncVault(pc.vault, cfg("pc"));
    const phone = await device();
    await syncVault(phone.vault, cfg("phone"));
    expect([...(await phone.vault.readBytes("Přílohy/foto.png"))]).toEqual([...png]);
    expect(phone.vault.snapshot().files).toEqual(["Přílohy/foto.png"]);
  });

  it("retries when another device pushed in the meantime", async () => {
    const pc = await device({ "A.md": "a" });
    await syncVault(pc.vault, cfg("pc"));
    await pc.vault.write("B.md", "b");
    await gh.externalCommit("C.md", "c z jinud");
    gh.failNextRefUpdate = true;
    const r = await syncVault(pc.vault, cfg("pc"));
    expect(r.pushed).toContain("B.md");
    expect(pc.vault.read("C.md")).toBe("c z jinud");
    expect(gh.snapshot()["B.md"]).toBe("b");
  });

  it("never deletes anything on the first sync with a different repository", async () => {
    const pc = await device({ "A.md": "a" });
    await syncVault(pc.vault, cfg("pc"));
    // Same vault, new empty repo: everything is uploaded again, nothing is removed locally.
    gh = new FakeGitHub();
    globalThis.fetch = gh.fetch as typeof fetch;
    await pc.storage.writePrivate("sync.json", JSON.stringify({ repo: "me/other", base: { "A.md": "x" } }));
    const r = await syncVault(pc.vault, cfg("pc"));
    expect(r.deletedLocal).toEqual([]);
    expect(r.pushed).toEqual(["A.md"]);
  });
});
