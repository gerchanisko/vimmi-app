// Image width written into the Markdown link (Obsidian style).
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/store", () => ({ getState: () => ({}), toast: () => {} }));
const { withWidth } = await import("../src/lib/editor-images");

describe("image width", () => {
  it("sets, changes and removes the width", () => {
    expect(withWidth("![](Přílohy/foto.jpg)", 400)).toBe("![|400](Přílohy/foto.jpg)");
    expect(withWidth("![Pes|300](Přílohy/pes%20maly.png)", 520)).toBe("![Pes|520](Přílohy/pes%20maly.png)");
    expect(withWidth("![Pes|300](a.png)", undefined)).toBe("![Pes](a.png)");
    expect(withWidth("![[foto.jpg]]", 250)).toBe("![[foto.jpg|250]]");
    expect(withWidth("![[foto.jpg|250]]", undefined)).toBe("![[foto.jpg]]");
    expect(withWidth("![[foto.jpg|100x80]]", 300)).toBe("![[foto.jpg|300]]");
    expect(withWidth('![](a.png "titulek")', 200)).toBe('![|200](a.png "titulek")');
  });
});
