// The AI assistant panel: chat with the chosen AI provider, tool activity, approvals for changes.
import { useEffect, useMemo, useRef, useState } from "react";
import { basename } from "../../shared/markdown";
import { PROVIDER_MAP, PROVIDERS, providerModel } from "../../shared/providers";
import type { AiEvent, Chat, ChatMessage, ChatPart, ChatSummary } from "../../shared/types";
import { collapseDiff, lineDiff } from "../lib/diff";
import { renderMarkdown } from "../lib/render";
import { activeNotePath, errorText, getState, openNote, openView, resolveLink, setState, toast, useApp } from "../lib/store";
import { followLink } from "./Editor";
import { Icon } from "./Icon";
import { openMenu } from "./Menu";

const TOOL_LABELS: Record<string, [string, string]> = {
  list_notes: ["Prochází poznámky", "Prošel poznámky"],
  read_note: ["Čte poznámku", "Přečetl poznámku"],
  search_notes: ["Hledá", "Prohledal trezor"],
  get_connections: ["Zjišťuje souvislosti", "Zjistil souvislosti"],
  list_tags: ["Prochází tagy", "Prošel tagy"],
  list_tasks: ["Prochází úkoly", "Prošel úkoly"],
  list_projects: ["Prochází projekty", "Prošel projekty"],
  get_daily_note: ["Otevírá deník", "Podíval se do deníku"],
  open_note: ["Otevírá poznámku", "Otevřel poznámku"],
  create_note: ["Vytváří poznámku", "Vytvořil poznámku"],
  edit_note: ["Upravuje poznámku", "Upravil poznámku"],
  append_to_note: ["Doplňuje poznámku", "Doplnil poznámku"],
  add_task: ["Přidává úkol", "Přidal úkol"],
  set_task_status: ["Mění stav úkolu", "Změnil stav úkolu"],
  rename_note: ["Přejmenovává", "Přejmenoval poznámku"],
  delete_note: ["Maže poznámku", "Přesunul poznámku do koše"],
};

const SUGGESTIONS = [
  { text: "Shrň mi tuhle poznámku", needsNote: true },
  { text: "Vytáhni z téhle poznámky úkoly a přidej je do ní", needsNote: true },
  { text: "Co mám dnes a tento týden udělat?" },
  { text: "Které poznámky spolu souvisí, ale nejsou propojené?" },
  { text: "Napiš týdenní přehled z mých poznámek a úkolů" },
];

function toolDetail(part: Extract<ChatPart, { kind: "tool" }>): string {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const v = input.path ?? input.query ?? input.text ?? input.from ?? input.folder ?? input.tag ?? input.date;
  return typeof v === "string" ? v : "";
}

function applyEvent(chat: Chat, e: AiEvent): Chat {
  const messages = chat.messages.slice();
  let last = messages.at(-1);
  if (e.type === "turn_start") {
    if (last?.role !== "assistant" || last.parts.length) messages.push({ role: "assistant", parts: [] });
    return { ...chat, messages };
  }
  if (!last || last.role !== "assistant") {
    last = { role: "assistant", parts: [] };
    messages.push(last);
  }
  const parts = last.parts.slice();
  const tail = parts.at(-1);
  const updateTool = (id: string, patch: Partial<Extract<ChatPart, { kind: "tool" }>>) => {
    const i = parts.findIndex((p) => p.kind === "tool" && p.id === id);
    if (i !== -1) parts[i] = { ...(parts[i] as Extract<ChatPart, { kind: "tool" }>), ...patch };
  };
  switch (e.type) {
    case "text":
      if (tail?.kind === "text" && !tail.closed) parts[parts.length - 1] = { ...tail, text: tail.text + e.delta };
      else parts.push({ kind: "text", text: e.delta });
      break;
    case "thinking":
      if (tail?.kind === "thinking" && !tail.closed) parts[parts.length - 1] = { ...tail, text: tail.text + e.delta };
      else parts.push({ kind: "thinking", text: e.delta });
      break;
    case "block_end":
      if (tail && (tail.kind === "text" || tail.kind === "thinking")) parts[parts.length - 1] = { ...tail, closed: true };
      break;
    case "tool_start":
      parts.push({ kind: "tool", id: e.id, name: e.name, status: "running" });
      break;
    case "tool_input":
      updateTool(e.id, { input: e.input });
      break;
    case "approval":
      updateTool(e.id, { status: "waiting", input: e.input, summary: e.summary, diff: e.diff });
      break;
    case "tool_result":
      updateTool(e.id, {
        status: e.ok ? "ok" : e.result.startsWith("Uživatel tuto změnu zamítl") ? "declined" : "error",
        result: e.result,
      });
      break;
    case "web_search":
      parts.push({ kind: "search", query: e.query });
      break;
    case "notice":
      parts.push({ kind: "notice", text: e.message });
      break;
    case "error":
      parts.push({ kind: "notice", text: `⚠ ${e.message}` });
      break;
    default:
      return chat;
  }
  messages[messages.length - 1] = { ...last, parts };
  return { ...chat, messages, updated: Date.now() };
}

export default function AiChat() {
  const settings = useApp((s) => s.settings);
  const draft = useApp((s) => s.aiDraft);
  const selection = useApp((s) => s.selection);
  const activePath = useApp(() => activeNotePath());
  const [chat, setChat] = useState<Chat | null>(null);
  const [history, setHistory] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [includeNote, setIncludeNote] = useState(true);
  const [usage, setUsage] = useState({ tokens: 0, cost: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<Chat | null>(null);
  chatRef.current = chat;
  const stick = useRef(true);

  // Start with the most recent chat, or a new one.
  useEffect(() => {
    void (async () => {
      const list = await window.vimmi.ai.chats();
      setHistory(list);
      const recent = list[0] && Date.now() - list[0].updated < 1000 * 60 * 60 * 6 ? await window.vimmi.ai.chat(list[0].id) : undefined;
      setChat(recent ?? (await window.vimmi.ai.newChat()));
    })();
  }, []);

  useEffect(() => {
    return window.vimmi.ai.onEvent((e) => {
      if (!chatRef.current || e.convId !== chatRef.current.id) return;
      if (e.type === "usage") {
        setUsage((u) => ({ tokens: u.tokens + e.input + e.output, cost: u.cost + (e.costUsd ?? 0) }));
        return;
      }
      if (e.type === "done" || e.type === "error") {
        setBusy(false);
        void window.vimmi.ai.chats().then(setHistory);
      }
      setChat((c) => (c ? applyEvent(c, e) : c));
    });
  }, []);

  useEffect(() => {
    if (draft === null) return;
    setInput(draft);
    setState({ aiDraft: null });
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(draft.length, draft.length);
    }, 0);
  }, [draft]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const send = async (text = input) => {
    const msg = text.trim();
    if (!msg || !chat || busy) return;
    if (!settings?.hasApiKey) {
      setState({ overlay: { type: "settings", tab: "ai" } });
      return;
    }
    const openPaths = getState().tabs.flatMap((t) => (t.kind === "note" ? [t.path] : []));
    const ctx = { activePath: includeNote ? activePath : undefined, selection: includeNote ? selection : undefined, openPaths };
    const userMsg: ChatMessage = { role: "user", parts: [{ kind: "text", text: msg }], context: ctx };
    setChat({ ...chat, title: chat.messages.length ? chat.title : msg.slice(0, 60), messages: [...chat.messages, userMsg] });
    setInput("");
    setBusy(true);
    stick.current = true;
    try {
      await window.vimmi.ai.send(chat.id, msg, ctx);
    } catch (err) {
      setBusy(false);
      toast(errorText(err), "error");
    }
  };

  const newChat = async () => {
    if (busy && chat) await window.vimmi.ai.stop(chat.id);
    setBusy(false);
    setUsage({ tokens: 0, cost: 0 });
    setChat(await window.vimmi.ai.newChat());
    inputRef.current?.focus();
  };

  const historyMenu = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(rect, [
      { heading: history.length ? "Předchozí chaty" : "Zatím žádná historie" },
      ...history.slice(0, 15).map((h) => ({
        label: h.title || "Bez názvu",
        icon: h.id === chat?.id ? "check" : "history",
        action: async () => {
          const c = await window.vimmi.ai.chat(h.id);
          if (c) {
            setChat(c);
            setBusy(false);
            setUsage({ tokens: 0, cost: 0 });
          }
        },
      })),
      ...(chat && chat.messages.length
        ? [
            { separator: true as const },
            {
              label: "Smazat tento chat",
              icon: "trash",
              danger: true,
              action: async () => {
                await window.vimmi.ai.deleteChat(chat.id);
                setHistory(await window.vimmi.ai.chats());
                await newChat();
              },
            },
          ]
        : []),
    ]);
  };

  const onMessageClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains("wikilink")) void followLink(a.dataset.target!, undefined, e.ctrlKey || e.metaKey);
    else if (a.classList.contains("tag")) openView("search", "#" + a.dataset.tag);
    else if (a.href.startsWith("http")) void window.vimmi.app.openExternal(a.href);
  };

  if (!settings?.hasApiKey) {
    const info = PROVIDER_MAP[settings?.provider ?? "anthropic"];
    return (
      <div className="ai-setup">
        <Icon name="sparkle" size={28} />
        <h3>AI asistent</h3>
        <p className="muted">
          Asistent umí číst tvoje poznámky, hledat souvislosti, shrnovat, plánovat a s tvým svolením i upravovat a vytvářet poznámky a úkoly.
        </p>
        <p className="muted">
          Vyber si poskytovatele: doporučený Claude nebo OpenRouter (i s bezplatnými modely), dále OpenAI, Gemini, nebo model běžící lokálně v Ollamě.
          Teď je vybraný <strong>{info.name}</strong> a chybí mu API klíč.
        </p>
        <button className="btn primary" onClick={() => setState({ overlay: { type: "settings", tab: "ai" } })}>
          <Icon name="key" /> Nastavit AI
        </button>
      </div>
    );
  }

  const model = providerModel(settings.provider, settings.models);
  const switchProvider = (e: React.MouseEvent) =>
    openMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), [
      { heading: "Poskytovatel AI" },
      ...PROVIDERS.filter((p) => settings.keys[p.id] || !p.needsKey).map((p) => ({
        label: `${p.name}${providerModel(p.id, settings.models) ? ` · ${providerModel(p.id, settings.models)}` : ""}`,
        icon: p.id === settings.provider ? "check" : p.free ? "sparkle" : "bot",
        action: () =>
          void window.vimmi.settings.set({ provider: p.id }).then((next) => setState({ settings: { ...settings, ...next } })),
      })),
      { separator: true },
      { label: "Nastavení AI…", icon: "settings", action: () => setState({ overlay: { type: "settings", tab: "ai" } }) },
    ]);

  return (
    <div className="ai-chat">
      <div className="panel-head">
        <button className="chat-title" onClick={historyMenu} title="Historie chatů">
          <span>{chat?.messages.length ? chat.title : "Nový chat"}</span>
          <Icon name="chevron-down" size={14} />
        </button>
        <button className="icon-btn" onClick={() => void newChat()} title="Nový chat" aria-label="Nový chat">
          <Icon name="new-chat" />
        </button>
      </div>

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!chat?.messages.length && (
          <div className="chat-empty">
            <p className="muted">Zeptej se na cokoliv o svých poznámkách. AI vidí otevřenou poznámku a umí prohledat celý trezor.</p>
            <div className="suggestions">
              {SUGGESTIONS.filter((s) => !s.needsNote || activePath).map((s) => (
                <button key={s.text} className="suggestion" onClick={() => void send(s.text)}>
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat?.messages.map((m, i) => (
          <Message key={i} message={m} onClick={onMessageClick} showThinking={settings.showThinking} last={i === chat.messages.length - 1} busy={busy} />
        ))}
      </div>

      <div className="chat-input">
        {activePath && (
          <div className="context-chips">
            <button className={`chip${includeNote ? " on" : ""}`} onClick={() => setIncludeNote(!includeNote)} title="Poslat Claudovi obsah otevřené poznámky">
              <Icon name="note" size={13} /> {basename(activePath)}
              {includeNote && selection ? " · výběr" : ""}
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={input}
          rows={Math.min(8, Math.max(2, input.split("\n").length))}
          placeholder="Napiš zprávu… (Enter odešle, Shift+Enter nový řádek)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="chat-input-row">
          <button className="model-switch muted small" onClick={switchProvider} title="Přepnout poskytovatele AI">
            {PROVIDER_MAP[settings.provider].name.split(" (")[0]} · {model || "vyber model"}
            {usage.tokens > 0 && ` · ${(usage.tokens / 1000).toFixed(1)}k tokenů`}
            {usage.cost > 0 && ` · ~$${usage.cost.toFixed(3)}`}
            <Icon name="chevron-down" size={12} />
          </button>
          {busy ? (
            <button className="btn" onClick={() => chat && void window.vimmi.ai.stop(chat.id)}>
              <Icon name="stop" size={14} /> Zastavit
            </button>
          ) : (
            <button className="btn primary" onClick={() => void send()} disabled={!input.trim()}>
              <Icon name="send" size={14} /> Odeslat
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Message({
  message,
  onClick,
  showThinking,
  last,
  busy,
}: {
  message: ChatMessage;
  onClick: (e: React.MouseEvent) => void;
  showThinking: boolean;
  last: boolean;
  busy: boolean;
}) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    return (
      <div className="msg user">
        <div className="bubble">{text}</div>
        {message.context?.activePath && <span className="msg-context">📄 {basename(message.context.activePath)}</span>}
      </div>
    );
  }
  const working = last && busy;
  const lastPart = message.parts.at(-1);
  return (
    <div className="msg assistant" onClick={onClick}>
      {message.parts.map((p, i) => (
        <Part key={i} part={p} showThinking={showThinking} />
      ))}
      {working && (!lastPart || lastPart.kind !== "text" || lastPart.closed) && (
        lastPart?.kind === "tool" && lastPart.status === "waiting" ? (
          <p className="muted thinking-dots">Čeká na tvoje schválení</p>
        ) : (
          <Working key={message.parts.length} />
        )
      )}
    </div>
  );
}

/** "AI pracuje" with the time spent waiting, so a slow (free, busy) server does not look frozen. */
function Working() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <p className="muted thinking-dots">
      AI pracuje{seconds >= 5 ? ` · ${seconds} s` : ""}
      {seconds >= 20 && <span className="small"> – model ještě nezačal odpovídat, bezplatné servery bývají vytížené</span>}
    </p>
  );
}

function Part({ part, showThinking }: { part: ChatPart; showThinking: boolean }) {
  const html = useMemo(
    () => (part.kind === "text" ? renderMarkdown(part.text, { resolve: (t) => resolveLink(t), blockRemoteImages: true }) : ""),
    [part],
  );
  switch (part.kind) {
    case "text":
      return <div className="markdown msg-text" dangerouslySetInnerHTML={{ __html: html }} />;
    case "thinking":
      if (!showThinking || !part.text.trim()) return null;
      return (
        <details className="thinking">
          <summary>
            <Icon name="brain" size={13} /> Přemýšlení
          </summary>
          <div className="thinking-text">{part.text}</div>
        </details>
      );
    case "search":
      return (
        <div className="tool-line">
          <Icon name="globe" size={13} /> Hledá na webu: <em>{part.query}</em>
        </div>
      );
    case "notice":
      return <div className="notice">{part.text}</div>;
    case "tool":
      return <ToolCard part={part} />;
  }
}

function ToolCard({ part }: { part: Extract<ChatPart, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const labels = TOOL_LABELS[part.name] ?? [part.name, part.name];
  const detail = toolDetail(part);
  const decide = (ok: boolean) => void window.vimmi.ai.approve(part.id, ok);

  if (part.status === "waiting") {
    return (
      <div className="approval">
        <div className="approval-head">
          <Icon name="alert" size={15} />
          <strong>{part.summary ?? labels[0]}</strong>
        </div>
        {part.diff && <DiffView before={part.diff.before} after={part.diff.after} />}
        <div className="approval-actions">
          <button className="btn primary" onClick={() => decide(true)}>
            <Icon name="check" size={14} /> Povolit
          </button>
          <button className="btn" onClick={() => decide(false)}>
            Zamítnout
          </button>
        </div>
      </div>
    );
  }

  const icon = part.status === "running" ? "spinner" : part.status === "ok" ? "ok" : part.status === "declined" ? "close" : "alert";
  const notePath = typeof (part.input as { path?: string })?.path === "string" ? resolveLink((part.input as { path: string }).path) : undefined;
  return (
    <div className={`tool-line status-${part.status}`}>
      <button className="tool-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={icon} size={13} className={part.status === "running" ? "spin" : ""} />
        <span>{part.status === "running" ? labels[0] : part.status === "declined" ? `Zamítnuto: ${part.summary ?? labels[0]}` : (part.summary ?? labels[1])}</span>
        {detail && !part.summary && <span className="muted tool-detail">{detail}</span>}
      </button>
      {notePath && part.status === "ok" && (
        <button className="link-btn" onClick={() => openNote(notePath)}>
          otevřít
        </button>
      )}
      {open && part.result && <pre className="tool-result">{part.result}</pre>}
    </div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => collapseDiff(lineDiff(before, after)), [before, after]);
  return (
    <div className="diff">
      {lines.map((l, i) =>
        l === null ? (
          <div key={i} className="diff-gap">
            ⋯
          </div>
        ) : (
          <div key={i} className={`diff-line ${l.type}`}>
            <span className="diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
            {l.text || " "}
          </div>
        ),
      )}
    </div>
  );
}
