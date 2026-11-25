import { describe, expect, it } from "vitest";
import { createMcpServer, mcpToolList } from "../shared/ai/mcp";
import { Vault } from "../shared/vault";
import { MemoryStorage } from "./memory-storage";

async function server() {
  const storage = new MemoryStorage();
  await storage.writeText("Nápady.md", "# Nápady\n- [ ] Koupit mléko @2026-01-02\n");
  const vault = new Vault(storage);
  await vault.load();
  const env = { vault, dailyFolder: "Deník", openNote: () => {} };
  const mcp = createMcpServer({ version: "9.9.9", env: async () => env });
  const rpc = async (method: string, params?: unknown, id: number | undefined = 1) => {
    const line = await mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return line ? JSON.parse(line) : null;
  };
  return { storage, vault, rpc, mcp };
}

describe("MCP server", () => {
  it("initializes with a supported protocol version", async () => {
    const { rpc } = await server();
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(r.result.serverInfo).toMatchObject({ name: "vimmi", version: "9.9.9" });
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.instructions).toContain("wikilinks");
    const newer = await rpc("initialize", { protocolVersion: "2099-01-01" });
    expect(newer.result.protocolVersion).toBe("2025-11-25");
  });

  it("does not answer notifications", async () => {
    const { mcp } = await server();
    expect(await mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
  });

  it("lists the vault tools with JSON Schema and hints, without app-only ones", async () => {
    const { rpc } = await server();
    const { tools } = (await rpc("tools/list")).result;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("search_notes");
    expect(names).toContain("add_event");
    expect(names).not.toContain("open_note");
    const del = tools.find((t: { name: string }) => t.name === "delete_note");
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t: { name: string }) => t.name === "read_note").inputSchema.type).toBe("object");
    expect(mcpToolList().every((t) => !t.description.includes("approves"))).toBe(true);
  });

  it("runs read and write tools on the vault", async () => {
    const { rpc, storage, vault } = await server();
    const read = await rpc("tools/call", { name: "read_note", arguments: { path: "Nápady" } });
    expect(read.result.isError).toBeUndefined();
    expect(read.result.content[0].text).toContain("Koupit mléko");

    const add = await rpc("tools/call", { name: "add_task", arguments: { text: "Zavolat mámě", note: "Nápady.md" } });
    expect(add.result.isError).toBeUndefined();
    expect(await storage.readText("Nápady.md")).toContain("Zavolat mámě");
    // Changes made through MCP are kept in the note's history like the in-app AI's.
    expect((await vault.history.list("Nápady.md")).some((v) => v.source === "ai")).toBe(true);
  });

  it("reports bad input and unknown tools as tool errors", async () => {
    const { rpc } = await server();
    const bad = await rpc("tools/call", { name: "read_note", arguments: {} });
    expect(bad.result.isError).toBe(true);
    const missing = await rpc("tools/call", { name: "read_note", arguments: { path: "Neexistuje" } });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toContain("neexistuje");
    const unknown = await rpc("tools/call", { name: "open_note", arguments: { path: "Nápady" } });
    expect(unknown.result.isError).toBe(true);
  });

  it("answers ping and rejects unknown methods and broken JSON", async () => {
    const { rpc, mcp } = await server();
    expect((await rpc("ping")).result).toEqual({});
    expect((await rpc("sampling/whatever")).error.code).toBe(-32601);
    expect(JSON.parse((await mcp.handleLine("{nope"))!).error.code).toBe(-32700);
  });
});

describe("MCP get_open_note", () => {
  async function withContext(ctx: unknown) {
    const storage = new MemoryStorage();
    await storage.writeText("Vg.md", "# Vg\ntest !!!\n");
    const vault = new Vault(storage);
    await vault.load();
    const env = { vault, dailyFolder: "Deník", openNote: () => {} };
    const mcp = createMcpServer({ version: "1", env: async () => env, openContext: async () => ctx as never });
    const call = async () => JSON.parse((await mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_open_note", arguments: {} } })))!).result;
    const list = JSON.parse((await mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })))!).result.tools;
    return { call, list, root: vault.root };
  }

  it("returns the open note with its content and selection", async () => {
    const { call, list } = await withContext({ vault: "mem", activePath: "Vg.md", selection: "test", openPaths: ["Vg.md", "Jiná.md"] });
    expect(list[0].name).toBe("get_open_note");
    const r = await call();
    expect(r.content[0].text).toContain("Otevřená poznámka: Vg.md");
    expect(r.content[0].text).toContain("test !!!");
    expect(r.content[0].text).toContain("Vybraný text");
    expect(r.content[0].text).toContain("Jiná.md");
  });

  it("says when Vimmi is closed, nothing is open, or another vault is open", async () => {
    expect((await (await withContext(null)).call()).content[0].text).toContain("neběží");
    expect((await (await withContext({ vault: "mem", activePath: null, selection: null, openPaths: [] })).call()).content[0].text).toContain("není otevřená");
    expect((await (await withContext({ vault: "/jinde", activePath: "Vg.md", selection: null, openPaths: [] })).call()).content[0].text).toContain("jiný trezor");
  });

  it("is not offered without the app context", async () => {
    expect(mcpToolList().some((t) => t.name === "get_open_note")).toBe(false);
  });
});
