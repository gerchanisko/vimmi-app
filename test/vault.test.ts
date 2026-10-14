import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUnderHeading, splitFrontmatter, Vault } from "../electron/vault";
import { TOOL_MAP, toolDefinitions } from "../shared/ai/tools";

let dir: string;
let vault: Vault;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vimmi-test-"));
  fs.mkdirSync(path.join(dir, "Projekty"));
  fs.writeFileSync(path.join(dir, "Nápady.md"), "# Nápady\nviz [[Web]] #nápady\n- [ ] Zkusit něco @2026-01-01 !1\n");
  fs.writeFileSync(path.join(dir, "Projekty", "Web.md"), "---\ntype: project\ntags: [web]\n---\n# Web\n- [ ] Logo\n");
  vault = new Vault(dir);
  await vault.load();
});

afterEach(() => {
  vault.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("vault", () => {
  it("indexes notes, tags, links and tasks", () => {
    const snap = vault.snapshot();
    expect(snap.notes.map((n) => n.path).sort()).toEqual(["Nápady.md", "Projekty/Web.md"]);
    expect(snap.folders).toEqual(["Projekty"]);
    const web = vault.meta("Projekty/Web.md")!;
    expect(web.type).toBe("project");
    expect(web.tags).toEqual(["web"]);
    expect(web.tasks[0]).toMatchObject({ line: 5, project: "Web", text: "Logo" });
    expect(vault.backlinks("Projekty/Web.md").map((b) => b.path)).toEqual(["Nápady.md"]);
  });

  it("refuses paths outside the vault", () => {
    expect(() => vault.abs("../venku.md")).toThrow();
    expect(() => vault.abs("/etc/passwd")).not.toThrow(); // leading slash is treated as vault-relative
    expect(vault.abs("/etc/passwd")).toBe(path.join(dir, "etc/passwd"));
  });

  it("searches accent-insensitively with tag filter", () => {
    expect(vault.search("napady").map((h) => h.path)).toContain("Nápady.md");
    expect(vault.search("#web").map((h) => h.path)).toEqual(["Projekty/Web.md"]);
    expect(vault.search("zkusit", { kind: "task" })[0].task?.line).toBe(2);
  });

  it("toggles tasks with a completion date", async () => {
    await vault.toggleTask("Nápady.md", 2);
    const line = fs.readFileSync(path.join(dir, "Nápady.md"), "utf8").split("\n")[2];
    expect(line).toMatch(/^- \[x\] Zkusit něco @2026-01-01 !1 ✅ \d{4}-\d{2}-\d{2}$/);
    await vault.toggleTask("Nápady.md", 2);
    expect(fs.readFileSync(path.join(dir, "Nápady.md"), "utf8").split("\n")[2]).toBe("- [ ] Zkusit něco @2026-01-01 !1");
  });

  it("renames and rewrites links", async () => {
    const to = await vault.rename("Projekty/Web.md", "Projekty/Web Vimmi.md");
    expect(to).toBe("Projekty/Web Vimmi.md");
    expect(fs.readFileSync(path.join(dir, "Nápady.md"), "utf8")).toContain("[[Web Vimmi]]");
    expect(vault.backlinks("Projekty/Web Vimmi.md").map((b) => b.path)).toEqual(["Nápady.md"]);
  });

  it("creates unique names and trashes notes", async () => {
    const a = await vault.create("Nápady", "x");
    expect(a).toBe("Nápady 1.md");
    await vault.trash(a);
    expect(vault.has(a)).toBe(false);
    expect(fs.readdirSync(path.join(dir, ".trash")).some((f) => f.endsWith("Nápady 1.md"))).toBe(true);
  });

  it("adds tasks under a heading", async () => {
    await vault.addTask("Nový úkol", { path: "Projekty/Web", due: "2026-02-02", priority: 2, heading: "Web" });
    expect(vault.read("Projekty/Web.md")).toContain("- [ ] Logo\n- [ ] Nový úkol @2026-02-02 !2");
  });
});

describe("helpers", () => {
  it("splits frontmatter and reports body offset", () => {
    const r = splitFrontmatter("---\na: 1\nb: [x, y]\n---\nbody");
    expect(r).toEqual({ data: { a: 1, b: ["x", "y"] }, body: "body", offset: 4 });
    expect(splitFrontmatter("---\na: [unclosed\n---\nx").data).toEqual({});
  });

  it("inserts under headings", () => {
    expect(insertUnderHeading("# A\n- 1\n\n# B\n- 2\n", "- 3", "A")).toBe("# A\n- 1\n- 3\n\n# B\n- 2\n");
    expect(insertUnderHeading("# A\n", "- x", "Nové")).toBe("# A\n\n## Nové\n- x\n");
    expect(insertUnderHeading("", "x")).toBe("x\n");
  });
});

describe("AI tools", () => {
  const env = () => ({ vault, dailyFolder: "Deník", openNote: () => {} });

  it("exposes valid JSON schemas", () => {
    const defs = toolDefinitions();
    expect(defs.length).toBeGreaterThan(10);
    for (const d of defs) expect((d as { input_schema: { type: string } }).input_schema.type).toBe("object");
  });

  it("read tools return vault content", async () => {
    expect(await TOOL_MAP.read_note.run({ path: "Web" }, env())).toContain("type: project");
    expect(await TOOL_MAP.list_tasks.run({ status: "open" }, env())).toContain("Logo");
    expect(await TOOL_MAP.list_projects.run({}, env())).toContain("Projekty/Web.md");
    expect(await TOOL_MAP.get_connections.run({ path: "Web" }, env())).toContain("Nápady.md");
  });

  it("edit_note preview rejects missing or ambiguous text and builds a diff", () => {
    expect(() => TOOL_MAP.edit_note.preview!({ path: "Nápady", old_text: "neexistuje", new_text: "x" }, env())).toThrow();
    const p = TOOL_MAP.edit_note.preview!({ path: "Nápady", old_text: "# Nápady", new_text: "# Moje nápady" }, env());
    expect(p.diff?.after.startsWith("# Moje nápady")).toBe(true);
  });

  it("write tools change files", async () => {
    await TOOL_MAP.edit_note.run({ path: "Nápady", old_text: "# Nápady", new_text: "# Moje nápady" }, env());
    expect(vault.read("Nápady.md").startsWith("# Moje nápady")).toBe(true);
    await TOOL_MAP.create_note.run({ path: "Nové/Test", content: "ahoj" }, env());
    expect(vault.read("Nové/Test.md")).toBe("ahoj");
  });
});
