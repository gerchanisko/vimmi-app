// Tells Claude Code (the Claude Code panel, or Claude Code / Claude Desktop with `vimmi --mcp`) which
// note is open in Vimmi: the MCP tool get_open_note reads it. Desktop app only; the file stays on
// this computer (the settings folder) and is removed when Vimmi closes.
import { activeNotePath, getState, subscribe } from "./store";

export function startClaudeContext(): () => void {
  const api = window.vimmi.claude;
  if (!api) return () => {};
  let last = "";
  let timer: number | undefined;
  const push = () => {
    const s = getState();
    const json = JSON.stringify({
      vault: s.snapshot?.root ?? null,
      activePath: activeNotePath() ?? null,
      selection: s.selection ? s.selection.slice(0, 4000) : null,
      openPaths: s.tabs.flatMap((t) => (t.kind === "note" ? [t.path] : [])),
    });
    if (json === last) return;
    last = json;
    clearTimeout(timer);
    timer = window.setTimeout(() => void api.setOpenNote(json).catch(() => {}), 250);
  };
  push();
  const off = subscribe(push);
  const clear = () => void api.setOpenNote(null).catch(() => {});
  window.addEventListener("beforeunload", clear);
  return () => {
    off();
    clearTimeout(timer);
    window.removeEventListener("beforeunload", clear);
  };
}
