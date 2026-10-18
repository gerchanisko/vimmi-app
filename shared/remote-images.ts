// Images from the internet load as soon as a note is shown, so their address reaches another
// server without a click. The AI must not add them to notes: hidden instructions in a note, a
// calendar invite or a web page could otherwise make it send the vault's contents out this way.
import type { Token } from "markdown-it";
import { createMarkdownIt } from "./markdown-it";

/** Image syntax the editor shows inline (src/lib/editor-images.ts). */
export const WIKI_IMAGE = /!\[\[([^\]|#\n]+?)(?:\|(\d+)(?:x\d+)?)?\]\]/g;
export const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

const parser = createMarkdownIt();

/** Any address with a scheme, except the ones the app serves itself. */
function isRemote(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(data|blob|vimmi-file):/i.test(src);
}

function collect(tokens: Token[], out: Set<string>): void {
  for (const t of tokens) {
    if (t.type === "image") {
      const src = String(t.attrGet("src") ?? "");
      if (isRemote(src)) out.add(src);
    }
    if (t.children) collect(t.children, out);
  }
}

/** Addresses of remote images in Markdown, as the reading view or the editor would load them. */
export function remoteImageSources(text: string): Set<string> {
  const out = new Set<string>();
  collect(parser.parse(text, {}), out);
  for (const m of text.matchAll(WIKI_IMAGE)) if (isRemote(m[1].trim())) out.add(m[1].trim());
  for (const m of text.matchAll(MD_IMAGE)) if (isRemote(m[2])) out.add(m[2]);
  return out;
}

/** Remote images in `after` that `before` did not have. */
export function newRemoteImages(before: string, after: string): string[] {
  const had = remoteImageSources(before);
  return [...remoteImageSources(after)].filter((src) => !had.has(src));
}
