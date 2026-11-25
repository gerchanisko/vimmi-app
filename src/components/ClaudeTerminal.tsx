// The Claude Code panel: a terminal with the user's own Claude Code (desktop app only). Claude Code
// signs in to the user's Claude account itself; Vimmi only shows the terminal and gives Claude the
// vault tools (vimmi --mcp).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../lib/store";
import { Icon } from "./Icon";

type Status = "starting" | "running" | "exited" | "missing" | "error";

/** An app colour (CSS variable) as "rgb(r, g, b)", the form xterm.js understands. */
function color(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name}, ${fallback})`;
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const m = c.match(/\d+(\.\d+)?/g);
  return m && m.length >= 3 ? `rgb(${m[0]}, ${m[1]}, ${m[2]})` : fallback;
}

function theme(): ITheme {
  const accent = color("--accent", "rgb(124, 140, 255)");
  return {
    background: color("--surface-2", "rgb(27, 27, 31)"),
    foreground: color("--text", "rgb(230, 230, 230)"),
    cursor: accent,
    selectionBackground: accent.replace("rgb(", "rgba(").replace(")", ", 0.3)"),
  };
}

export default function ClaudeTerminal({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ xterm: Terminal; fit: FitAddon; id?: number } | null>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [message, setMessage] = useState("");
  const api = window.vimmi.claude!.terminal;

  const fitNow = () => {
    const t = term.current;
    if (!t || !host.current || host.current.clientWidth < 50) return;
    t.fit.fit();
    if (t.id !== undefined) void api.resize(t.id, t.xterm.cols, t.xterm.rows).catch(() => {});
  };

  const start = async () => {
    const t = term.current;
    if (!t) return;
    setStatus("starting");
    const setup = await window.vimmi.claude!.setup().catch(() => null);
    if (!setup?.claudeCodeFound) {
      setStatus("missing");
      return;
    }
    t.xterm.reset();
    fitNow();
    try {
      t.id = await api.open(
        t.xterm.cols,
        t.xterm.rows,
        (data) => t.xterm.write(data),
        (code) => {
          t.id = undefined;
          t.xterm.write(`\r\n\x1b[2m[Claude Code skončil${code ? ` (kód ${code})` : ""}]\x1b[0m\r\n`);
          setStatus("exited");
        },
      );
      setStatus("running");
      t.xterm.focus();
    } catch (err) {
      setMessage(errorText(err));
      setStatus("error");
    }
  };

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const xterm = new Terminal({
      fontFamily: css.getPropertyValue("--mono").trim() || "monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
      theme: theme(),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current!);
    term.current = { xterm, fit };
    xterm.onData((d) => {
      const id = term.current?.id;
      if (id !== undefined) void api.write(id, d).catch(() => {});
    });
    const resize = new ResizeObserver(() => fitNow());
    resize.observe(host.current!);
    // Light/dark switch: the terminal takes the app's colours.
    const themeWatch = new MutationObserver(() => (xterm.options.theme = theme()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    void start();
    return () => {
      resize.disconnect();
      themeWatch.disconnect();
      const id = term.current?.id;
      if (id !== undefined) void api.close(id);
      xterm.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fitNow();
      term.current?.xterm.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    // Keys typed in the terminal belong to Claude Code, not to Vimmi's shortcuts.
    <div className="claude-terminal" onKeyDown={(e) => e.stopPropagation()}>
      <div className="claude-terminal-bar">
        <span className="muted small">Claude Code · tvůj účet Claude</span>
        <span className="grow" />
        {(status === "exited" || status === "error") && (
          <button className="btn small" onClick={() => void start()}>
            <Icon name="sync" size={13} /> Spustit znovu
          </button>
        )}
        {status === "running" && (
          <button
            className="btn small"
            title="Ukončit Claude Code"
            onClick={() => {
              const id = term.current?.id;
              if (id !== undefined) void api.close(id);
            }}
          >
            <Icon name="stop" size={13} /> Ukončit
          </button>
        )}
      </div>
      {status === "missing" && (
        <div className="claude-terminal-note">
          <p>Claude Code tady není nainstalovaný.</p>
          <p className="muted small">
            Nainstaluj ho podle návodu na code.claude.com, přihlas se v něm svým účtem Claude (Pro nebo Max) a pak tady klikni na Zkusit znovu.
          </p>
          <div className="row-actions">
            <button className="btn" onClick={() => void window.vimmi.app.openExternal("https://code.claude.com/docs")}>
              Návod <Icon name="external" size={13} />
            </button>
            <button className="btn" onClick={() => void start()}>
              Zkusit znovu
            </button>
          </div>
        </div>
      )}
      {status === "error" && <p className="error-text small claude-terminal-note">{message}</p>}
      <div ref={host} className="claude-terminal-screen" hidden={status === "missing"} />
    </div>
  );
}
