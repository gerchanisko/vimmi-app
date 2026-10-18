// The Markdown parser of the reading view, shared with the check on AI edits (remote-images.ts)
// so both see exactly the same images. Rendering rules live in src/lib/render.ts.
import MarkdownIt, { type StateInline } from "markdown-it";

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src.slice(state.pos);
  const embed = src.startsWith("![[");
  if (!embed && !src.startsWith("[[")) return false;
  const m = src.match(/^!?\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/);
  if (!m) return false;
  if (!silent) {
    const token = state.push(embed ? "wiki_embed" : "wikilink", "", 0);
    token.meta = { target: m[1].trim(), heading: m[2]?.slice(1), alias: m[3] };
  }
  state.pos += m[0].length;
  return true;
}

function tagRule(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== "#") return false;
  const prev = state.pos === 0 ? " " : state.src[state.pos - 1];
  if (!/[\s(,]/.test(prev)) return false;
  const m = state.src.slice(state.pos).match(/^#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/u);
  if (!m) return false;
  if (!silent) {
    const token = state.push("vtag", "", 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
}

/** Markdown-it with Vimmi's syntax: [[wikilinks]], ![[embeds]] and #tags. Raw HTML stays text. */
export function createMarkdownIt() {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("emphasis", "vtag", tagRule);
  return md;
}
