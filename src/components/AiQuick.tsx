// One-shot AI writing actions on the selection or the whole note, with a result preview.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { newRemoteImages } from "../../shared/remote-images";
import type { QuickAction } from "../../shared/types";
import { renderMarkdown } from "../lib/render";
import { activeNotePath, getState, setState, toast } from "../lib/store";
import { renamePath } from "../lib/actions";
import { getActiveEditor, insertIntoEditor } from "./Editor";
import { Icon } from "./Icon";

export const QUICK_ACTIONS: { action: QuickAction; label: string; icon: string }[] = [
  { action: "summarize", label: "Shrnout", icon: "summary" },
  { action: "improve", label: "Vylepšit text", icon: "sparkle" },
  { action: "fix_grammar", label: "Opravit pravopis", icon: "check" },
  { action: "shorten", label: "Zkrátit", icon: "shrink" },
  { action: "expand", label: "Rozvést", icon: "expand" },
  { action: "continue", label: "Pokračovat v psaní", icon: "pen" },
  { action: "extract_tasks", label: "Vytáhnout úkoly", icon: "task" },
  { action: "outline", label: "Udělat osnovu", icon: "list" },
  { action: "explain", label: "Vysvětlit", icon: "help" },
  { action: "translate_en", label: "Přeložit do angličtiny", icon: "globe" },
  { action: "translate_cs", label: "Přeložit do češtiny", icon: "globe" },
  { action: "suggest_title", label: "Navrhnout název", icon: "title" },
  { action: "suggest_tags", label: "Navrhnout tagy", icon: "tag" },
  { action: "custom", label: "Vlastní pokyn…", icon: "command" },
];

interface QuickState {
  id: string;
  action: QuickAction;
  label: string;
  source: "selection" | "note";
  notePath?: string;
  status: "running" | "done" | "error";
  text: string;
  error?: string;
}

let quick: QuickState | null = null;
const listeners = new Set<() => void>();
const setQuick = (q: QuickState | null) => {
  quick = q;
  for (const l of listeners) l();
};
const useQuick = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => quick,
  );

let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  window.vimmi.ai.onQuick((e) => {
    if (!quick || quick.id !== e.id) return;
    if (e.type === "delta") setQuick({ ...quick, text: quick.text + e.delta });
    else if (e.type === "done") setQuick({ ...quick, status: "done", text: e.text });
    else setQuick({ ...quick, status: "error", error: e.message });
  });
}

/** Starts a quick action on the editor selection, or on the whole note when nothing is selected. */
export async function runQuick(action: QuickAction, label: string, instruction?: string, override?: { text: string; source: "selection" | "note" }) {
  subscribe();
  if (!getState().settings?.hasApiKey) {
    toast("Nejdřív nastav AI poskytovatele a klíč v Nastavení → AI.", "error");
    setState({ overlay: { type: "settings", tab: "ai" } });
    return;
  }
  const ed = getActiveEditor();
  const notePath = activeNotePath();
  let text = override?.text ?? "";
  let source: "selection" | "note" = override?.source ?? "note";
  if (!override) {
    const sel = ed?.view.state.selection.main;
    if (ed && sel && !sel.empty) {
      text = ed.view.state.sliceDoc(sel.from, sel.to);
      source = "selection";
    } else if (notePath) {
      text = ed?.path === notePath ? ed.view.state.doc.toString() : await window.vimmi.vault.read(notePath);
    }
  }
  if (!text.trim()) {
    toast("Není s čím pracovat – poznámka je prázdná.");
    return;
  }
  if (action === "custom" && !instruction) {
    setQuick({ id: "", action, label, source, notePath, status: "running", text: "", error: undefined });
    pendingText = text;
    return;
  }
  const id = crypto.randomUUID();
  setQuick({ id, action, label, source, notePath, status: "running", text: "" });
  await window.vimmi.ai.quick({ id, action, text, notePath, instruction });
}

let pendingText = "";

function CustomInstruction({ label }: { label: string }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => {
    if (!value.trim()) return;
    const src = quick?.source ?? "note";
    void runQuick("custom", label, value.trim(), { text: pendingText, source: src });
  };
  return (
    <div className="quick-custom">
      <textarea
        ref={ref}
        value={value}
        rows={3}
        placeholder="Co má AI s textem udělat? Např. „Přepiš to jako e-mail pro kolegy“"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="dialog-actions">
        <button className="btn" onClick={() => setQuick(null)}>
          Zrušit
        </button>
        <button className="btn primary" onClick={submit} disabled={!value.trim()}>
          Spustit
        </button>
      </div>
    </div>
  );
}

export function AiQuickPanel() {
  const q = useQuick();
  if (!q) return null;
  const close = () => {
    if (q.status === "running" && q.id) void window.vimmi.ai.stopQuick(q.id);
    setQuick(null);
  };
  const apply = (mode: "replace" | "below") => {
    let text = q.text;
    if (q.action === "suggest_tags") text = text.trim();
    // Same rule as AI edits in the vault: no new images from the internet (they would load by themselves).
    const doc = getActiveEditor()?.view.state.doc.toString() ?? "";
    if (newRemoteImages(doc, text).length) {
      toast("Výsledek obsahuje obrázky z internetu, tak ho Vimmi nevloží. Zkopíruj si ho a zkontroluj.", "error");
      return;
    }
    if (!insertIntoEditor(text, mode)) {
      toast("Otevři poznámku v režimu úprav, kam se má text vložit.", "error");
      return;
    }
    setQuick(null);
  };
  const rename = async () => {
    if (!q.notePath) return;
    const title = q.text.trim().replace(/^["„“]+|["“”]+$/g, "");
    setQuick(null);
    await renamePath(q.notePath, false, title);
  };
  const copy = () => {
    void navigator.clipboard.writeText(q.text);
    toast("Zkopírováno.", "ok");
  };

  const awaitingInstruction = q.action === "custom" && !q.id;

  return (
    <div className="quick-panel" role="dialog" aria-label={`AI: ${q.label}`}>
      <div className="quick-head">
        <Icon name="sparkle" />
        <strong>{q.label}</strong>
        <span className="muted">{q.source === "selection" ? "výběr" : "celá poznámka"}</span>
        <button className="icon-btn" onClick={close} aria-label="Zavřít" title="Zavřít (Esc)">
          <Icon name="close" />
        </button>
      </div>
      {awaitingInstruction ? (
        <CustomInstruction label={q.label} />
      ) : (
        <>
          <div className="quick-body markdown">
            {q.status === "error" ? (
              <p className="error-text">{q.error}</p>
            ) : q.text ? (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(q.text, { blockRemoteImages: true }) }} />
            ) : (
              <p className="muted thinking-dots">AI přemýšlí</p>
            )}
          </div>
          <div className="quick-actions">
            {q.status === "running" ? (
              <button className="btn" onClick={close}>
                Zastavit
              </button>
            ) : q.status === "done" ? (
              <>
                {q.source === "selection" && ["improve", "shorten", "expand", "fix_grammar", "translate_en", "translate_cs", "outline"].includes(q.action) && (
                  <button className="btn primary" onClick={() => apply("replace")}>
                    Nahradit výběr
                  </button>
                )}
                {q.action === "suggest_title" && q.notePath ? (
                  <button className="btn primary" onClick={() => void rename()}>
                    Přejmenovat…
                  </button>
                ) : null}
                <button className={`btn${q.source === "note" && q.action !== "suggest_title" ? " primary" : ""}`} onClick={() => apply("below")}>
                  Vložit pod
                </button>
                <button className="btn" onClick={copy}>
                  Kopírovat
                </button>
                <button className="btn ghost" onClick={close}>
                  Zahodit
                </button>
              </>
            ) : (
              <button className="btn" onClick={close}>
                Zavřít
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
