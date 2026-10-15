// Note version history: local versions before changes, and versions from GitHub commits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteHistory, remoteVersion, syncVault, type SyncConfig } from "../shared/sync";
import { Vault } from "../shared/vault";
import { FakeGitHub } from "./fake-github";
import { MemoryStorage } from "./memory-storage";

async function vaultWith(files: Record<string, string>) {
  const storage = new MemoryStorage();
  for (const [p, t] of Object.entries(files)) await storage.writeText(p, t);
  const vault = new Vault(storage);
  await vault.load();
  return vault;
}

afterEach(() => vi.useRealTimers());

describe("local history", () => {
  it("keeps the previous text, at most once per 10 minutes while typing", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T10:00:00") });
    const v = await vaultWith({ "A.md": "první" });
    await v.write("A.md", "druhá");
    await v.write("A.md", "třetí");
    expect((await v.history.list("A.md")).length).toBe(1);
    vi.setSystemTime(new Date("2026-10-15T10:11:00"));
    await v.write("A.md", "čtvrtá");
    const versions = await v.history.list("A.md");
    expect(versions.map((x) => x.source)).toEqual(["edit", "edit"]);
    expect(await v.history.read("A.md", versions[0].id)).toBe("třetí");
    expect(await v.history.read("A.md", versions[1].id)).toBe("první");
  });

  it("always keeps the text before AI edits, sync and deletion", async () => {
    const v = await vaultWith({ "A.md": "moje", "B.md": "smazat" });
    await v.as("ai", () => v.write("A.md", "od AI"));
    await v.as("ai", () => v.write("A.md", "od AI znovu"));
    await v.writeSynced("A.md", new TextEncoder().encode("z telefonu"));
    await v.trash("B.md");
    const a = await v.history.list("A.md");
    expect(a.map((x) => x.source)).toEqual(["sync", "ai", "ai"]);
    expect(await v.history.read("A.md", a[2].id)).toBe("moje");
    const b = await v.history.list("B.md");
    expect(b[0].source).toBe("trash");
    expect(await v.history.read("B.md", b[0].id)).toBe("smazat");
  });

  it("history follows a renamed note", async () => {
    const v = await vaultWith({ "A.md": "text" });
    await v.as("ai", () => v.write("A.md", "nový"));
    await v.rename("A.md", "Složka/B");
    expect(await v.history.list("A.md")).toEqual([]);
    const moved = await v.history.list("Složka/B.md");
    expect(await v.history.read("Složka/B.md", moved[0].id)).toBe("text");
  });

  it("rejects odd version ids", async () => {
    const v = await vaultWith({ "A.md": "x" });
    expect(await v.history.read("A.md", "../../sync.json")).toBeNull();
  });
});

describe("history from GitHub", () => {
  let gh: FakeGitHub;
  const realFetch = globalThis.fetch;
  const cfg = (device: string): SyncConfig => ({ owner: "me", repo: "notes", token: "t", device, apiBase: "https://gh.test" });
  beforeEach(() => {
    gh = new FakeGitHub();
    globalThis.fetch = gh.fetch as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists the commits that changed a note and reads old versions", async () => {
    const pc = await vaultWith({ "A.md": "verze 1", "B.md": "jiná" });
    await syncVault(pc, cfg("počítač"));
    await pc.write("A.md", "verze 2");
    await syncVault(pc, cfg("iPhone"));
    await pc.write("B.md", "jen B");
    await syncVault(pc, cfg("počítač"));

    const versions = await remoteHistory(cfg("počítač"), "A.md");
    expect(versions.map((v) => v.device)).toEqual(["iPhone", "počítač"]);
    expect(await remoteVersion(cfg("x"), "A.md", versions[0].id)).toBe("verze 2");
    expect(await remoteVersion(cfg("x"), "A.md", versions[1].id)).toBe("verze 1");
  });
});
