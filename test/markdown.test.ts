import { describe, expect, it } from "vitest";
import {
  backlinksOf,
  extractTags,
  fold,
  formatTask,
  parseNote,
  parseTaskLine,
  resolveLinks,
  resolveLinkTarget,
  rewriteLinks,
  taskDisplayText,
  toggleTaskInLine,
} from "../shared/markdown";

const stat = { mtime: 0, ctime: 0 };

describe("tags", () => {
  it("finds tags with Czech letters and nesting, ignores numbers and headings", () => {
    expect(extractTags("Ahoj #začínáme a #práce/web, ne #123")).toEqual(["začínáme", "práce/web"]);
    const note = parseNote("a.md", "# Nadpis\n#tag1 text", {}, stat);
    expect(note.tags).toEqual(["tag1"]);
  });

  it("ignores tags and links in code", () => {
    const note = parseNote("a.md", "```\n#nope [[Nope]]\n```\n`#nope2` #yes", {}, stat);
    expect(note.tags).toEqual(["yes"]);
    expect(note.links).toEqual([]);
  });

  it("merges frontmatter tags", () => {
    const note = parseNote("a.md", "text #b", { tags: ["A", "#c"] }, stat);
    expect(note.tags).toEqual(["a", "b", "c"]);
  });
});

describe("tasks", () => {
  it("parses due date, priority and tags", () => {
    expect(parseTaskLine("- [ ] Zavolat mámě @2026-10-14 !1 #rodina")).toMatchObject({
      done: false,
      due: "2026-10-14",
      priority: 1,
      tags: ["rodina"],
    });
    expect(parseTaskLine("  * [x] hotovo 📅 2026-01-02 🔼")).toMatchObject({ done: true, due: "2026-01-02", priority: 2 });
    expect(parseTaskLine("- obyčejná odrážka")).toBeNull();
  });

  it("formats, toggles and cleans task text", () => {
    const line = formatTask("Napsat report", { due: "2026-10-20", priority: 2 });
    expect(line).toBe("- [ ] Napsat report @2026-10-20 !2");
    expect(toggleTaskInLine(line)).toBe("- [x] Napsat report @2026-10-20 !2");
    expect(taskDisplayText("Napsat report @2026-10-20 !2")).toBe("Napsat report");
  });

  it("records line numbers including the frontmatter offset and project", () => {
    const note = parseNote("Projekty/Web.md", "# Web\n- [ ] a\n- [x] b", { type: "project" }, stat, 4);
    expect(note.tasks.map((t) => [t.line, t.done, t.project])).toEqual([
      [5, false, "Web"],
      [6, true, "Web"],
    ]);
  });
});

describe("links", () => {
  const paths = ["Nápady.md", "Projekty/Web.md", "Archiv/Web.md", "Projekty/Plán.md"];

  it("resolves by path, by name and prefers the shortest path", () => {
    expect(resolveLinkTarget("Nápady", paths)).toBe("Nápady.md");
    expect(resolveLinkTarget("nápady", paths)).toBe("Nápady.md");
    expect(resolveLinkTarget("Archiv/Web", paths)).toBe("Archiv/Web.md");
    expect(resolveLinkTarget("Web#Cíle", paths)).toBe("Archiv/Web.md");
    expect(resolveLinkTarget("Plán", paths, "Projekty/Web.md")).toBe("Projekty/Plán.md");
    expect(resolveLinkTarget("Neexistuje", paths)).toBeUndefined();
  });

  it("computes backlinks", () => {
    const a = parseNote("A.md", "viz [[B]] a [[B|alias]]", {}, stat);
    const b = parseNote("B.md", "nic", {}, stat);
    resolveLinks([a, b]);
    expect(backlinksOf("B.md", [a, b])).toEqual([{ path: "A.md", title: "A", lines: [0, 0] }]);
  });

  it("rewrites links after rename, keeping heading and alias", () => {
    const text = "[[Staré]] a [[Staré#Cíle|cíle]] a [[Jiné]]";
    const out = rewriteLinks(text, "Staré.md", "Nové.md", ["Nové.md", "Jiné.md"], "X.md");
    expect(out).toBe("[[Nové]] a [[Nové#Cíle|cíle]] a [[Jiné]]");
  });
});

it("folds accents for search", () => {
  expect(fold("Úkol Žluťoučký")).toBe("ukol zlutoucky");
});
