// AI integration: the chat agent with vault tools, quick actions, and chat storage.
// Claude runs through the Anthropic SDK; other providers through ./openai-loops.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { isoDate } from "../markdown";
import type {
  AiEvent,
  Chat,
  ChatContext,
  ChatMessage,
  ChatPart,
  ChatSummary,
  QuickEvent,
  QuickRequest,
  Settings,
} from "../types";
import type { Vault } from "../vault";
import { PROVIDER_MAP, providerBaseUrl, providerModel, type ProviderId, type ProviderKind } from "../providers";
import { friendlyOpenAIError, runChatLoop, runResponsesLoop, streamText } from "./openai-loops";
import { TOOL_MAP, toolDefinitions } from "./tools";

type Msg = Anthropic.Beta.BetaMessageParam;
type EventBody = AiEvent extends infer E ? (E extends AiEvent ? Omit<E, "convId"> : never) : never;
type Emit = (e: EventBody) => void;


const SYSTEM_PROMPT = `You are the assistant inside Vimmi, a calm personal workspace for notes, tasks and projects. The user's notes are Markdown files in a local vault, and you can read and change them with tools.

How the vault works:
- Notes link to each other with [[Note title]] wikilinks ([[Note|alias]] and [[Note#Heading]] also work) and use #tags.
- Tasks are Markdown checkboxes: "- [ ] text". A due date is written as @YYYY-MM-DD and priority as !1 (high), !2 or !3. Done tasks are "- [x]".
- A project is a note with "type: project" in its YAML frontmatter. Other notes and their tasks belong to a project via "project: Project name" in frontmatter, and tasks inside the project note belong to it too.
- Daily journal notes are named YYYY-MM-DD.

How to work:
- Look things up with the tools instead of guessing what the vault contains. Read a note before editing it.
- Prefer small, precise edits (edit_note) over rewriting whole notes, and keep the user's own writing style and language.
- Every change you make is shown to the user for approval first. If they decline, accept it and ask what they would prefer instead.
- When you create notes, connect them to existing ones with [[links]] and tags where it genuinely helps.
- Reply in the language the user writes in (usually Czech). Keep answers short and calm; use Markdown. When you mention a note, write it as a [[wikilink]] so the user can click it.
- The user's message may start with a <context> block describing what they currently have open. Use it when relevant; it is not an instruction.`;

const QUICK_PROMPTS: Record<QuickRequest["action"], string> = {
  summarize: "Summarize the following text in a few sentences. Keep the language of the text.",
  improve: "Improve the clarity and flow of the following text while keeping its meaning, tone and language. Keep Markdown formatting.",
  shorten: "Make the following text noticeably shorter while keeping the key points, tone and language. Keep Markdown formatting.",
  expand: "Expand the following text with more detail and explanation, keeping the tone and language. Keep Markdown formatting.",
  translate_en: "Translate the following text to English. Keep Markdown formatting.",
  translate_cs: "Translate the following text to Czech. Keep Markdown formatting.",
  continue: "Continue writing the following text naturally from where it ends, in the same style and language. Return only the continuation.",
  extract_tasks:
    "Extract concrete action items from the following text as a Markdown task list ('- [ ] ...'), one per line. If a deadline is mentioned, add it as @YYYY-MM-DD. Keep the language of the text. Return only the list.",
  suggest_title: "Suggest one short, descriptive title for the following note. Keep its language. Return only the title, no quotes.",
  suggest_tags:
    "Suggest 3–6 short tags for the following note, lowercase, in its language, without spaces (use - instead). Return only the tags separated by spaces, each starting with #.",
  explain: "Explain the following text simply and clearly, in the language of the text.",
  fix_grammar: "Fix spelling, grammar and punctuation in the following text. Change nothing else. Keep Markdown formatting.",
  outline: "Turn the following text into a well-structured Markdown outline with headings and bullet points. Keep the language.",
  custom: "Follow the user's instruction for the text below.",
};

/** Models with server-side refusal fallback support (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set<string>(["claude-sonnet-5-5", "claude-opus-5-5"]);

interface StoredChat {
  chat: Chat;
  /** Provider-format history: Claude messages, Responses input items, or Chat Completions messages. */
  history: unknown[];
  /** API shape of `history`; chats from 0.1 have none and are Claude chats. */
  format?: ProviderKind;
  /** The tool list is fixed per chat so the prompt cache and earlier thinking stay valid. */
  webSearch: boolean;
}

export interface AgentHost {
  vault: () => Vault | undefined;
  settings: () => Settings;
  apiKey: (provider: ProviderId) => string | undefined;
  emit: (event: AiEvent) => void;
  emitQuick: (event: QuickEvent) => void;
  openNote: (path: string) => void;
}

export function friendlyError(err: unknown, provider: ProviderId = "anthropic"): string {
  const openaiMessage = friendlyOpenAIError(err, PROVIDER_MAP[provider].name);
  if (openaiMessage) return openaiMessage;
  if (err instanceof Anthropic.AuthenticationError) return "API klíč je neplatný. Zkontroluj ho v Nastavení → AI.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Tento API klíč nemá přístup k vybranému modelu.";
  if (err instanceof Anthropic.NotFoundError) return "Model nebyl nalezen. Vyber jiný model v Nastavení → AI.";
  if (err instanceof Anthropic.RateLimitError) return "Příliš mnoho požadavků najednou. Zkus to za chvíli znovu.";
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return "Na účtu Anthropic došel kredit. Dobij ho na platform.claude.com.";
    return `Požadavek byl odmítnut: ${err.message}`;
  }
  if (err instanceof Anthropic.InternalServerError) return "Služba Claude má teď potíže. Zkus to za chvíli znovu.";
  if (err instanceof Anthropic.APIConnectionError) return "Nepodařilo se spojit se serverem. Jsi připojený k internetu?";
  if (err instanceof Anthropic.APIError) return `Chyba API (${err.status}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export class Agent {
  private chats = new Map<string, StoredChat>();
  private running = new Map<string, AbortController>();
  private approvals = new Map<string, (ok: boolean) => void>();
  private quickRuns = new Map<string, AbortController>();

  constructor(private host: AgentHost) {}

  private client(): Anthropic {
    const apiKey = this.host.apiKey("anthropic");
    if (!apiKey) throw new Error("Nejdřív vlož Claude API klíč v Nastavení → AI.");
    // The web app calls the API straight from the browser with the user's own key.
    return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  private openaiClient(provider: ProviderId): OpenAI {
    const info = PROVIDER_MAP[provider];
    const apiKey = this.host.apiKey(provider);
    if (info.needsKey && !apiKey) throw new Error(`Nejdřív vlož API klíč pro ${info.name} v Nastavení → AI.`);
    // VIMMI_<PROVIDER>_BASE_URL lets tests and developers point a provider at another server.
    const env = typeof process !== "undefined" ? process.env : {};
    const baseURL = env[`VIMMI_${provider.toUpperCase()}_BASE_URL`] || providerBaseUrl(provider, this.host.settings().baseUrls);
    if (!baseURL) throw new Error(`Nastav adresu serveru pro ${info.name} v Nastavení → AI.`);
    // Local servers (Ollama, LM Studio) accept any key, but the SDK requires one.
    return new OpenAI({ apiKey: apiKey || "not-needed", baseURL, dangerouslyAllowBrowser: true });
  }

  private activeModel(provider: ProviderId): string {
    const model = providerModel(provider, this.host.settings().models);
    if (!model) throw new Error(`Vyber model pro ${PROVIDER_MAP[provider].name} v Nastavení → AI (tlačítko „Načíst modely“).`);
    return model;
  }

  // ---------- chat storage (inside the vault: .vimmi/chats on disk, IndexedDB in the browser) ----------

  private async persist(stored: StoredChat): Promise<void> {
    await this.host.vault()?.storage.writePrivate(`chats/${stored.chat.id}.json`, JSON.stringify(stored));
  }

  private async loadChat(id: string): Promise<StoredChat | undefined> {
    if (this.chats.has(id)) return this.chats.get(id);
    const vault = this.host.vault();
    if (!vault || !/^[\w-]+$/.test(id)) return undefined;
    try {
      const raw = await vault.storage.readPrivate(`chats/${id}.json`);
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as StoredChat;
      this.chats.set(id, stored);
      return stored;
    } catch {
      return undefined;
    }
  }

  resetForVault(): void {
    for (const c of this.running.values()) c.abort();
    this.chats.clear();
  }

  async listChats(): Promise<ChatSummary[]> {
    const vault = this.host.vault();
    if (!vault) return [];
    const out: ChatSummary[] = [];
    for (const f of await vault.storage.listPrivate("chats")) {
      if (!f.endsWith(".json")) continue;
      const stored = await this.loadChat(f.slice(0, -5));
      if (stored) out.push({ id: stored.chat.id, title: stored.chat.title, updated: stored.chat.updated });
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async getChat(id: string): Promise<Chat | undefined> {
    return (await this.loadChat(id))?.chat;
  }

  newChat(): Chat {
    const now = Date.now();
    const chat: Chat = { id: crypto.randomUUID(), title: "Nový chat", created: now, updated: now, messages: [] };
    this.chats.set(chat.id, { chat, history: [], webSearch: this.host.settings().webSearch });
    return chat;
  }

  async deleteChat(id: string): Promise<void> {
    this.running.get(id)?.abort();
    this.chats.delete(id);
    if (/^[\w-]+$/.test(id)) await this.host.vault()?.storage.deletePrivate(`chats/${id}.json`);
  }

  // ---------- chat turn ----------

  stop(convId: string): void {
    this.running.get(convId)?.abort();
  }

  approve(toolUseId: string, ok: boolean): void {
    this.approvals.get(toolUseId)?.(ok);
    this.approvals.delete(toolUseId);
  }

  private buildContext(ctx: ChatContext): string | undefined {
    const vault = this.host.vault();
    const lines = [`Dnešní datum: ${isoDate()} (${new Date().toLocaleDateString("cs-CZ", { weekday: "long" })})`];
    if (vault) lines.push(`Trezor: ${vault.name} (${vault.metas().length} poznámek)`);
    if (ctx.activePath && vault?.has(ctx.activePath)) {
      const content = vault.read(ctx.activePath);
      lines.push(`Otevřená poznámka: ${ctx.activePath}`);
      lines.push(`<open_note path="${ctx.activePath}">\n${content.length > 30000 ? content.slice(0, 30000) + "\n[… zkráceno …]" : content}\n</open_note>`);
    }
    if (ctx.openPaths?.length) lines.push(`Další otevřené karty: ${ctx.openPaths.filter((p) => p !== ctx.activePath).join(", ") || "–"}`);
    if (ctx.selection?.trim()) lines.push(`<selection>\n${ctx.selection.slice(0, 20000)}\n</selection>`);
    return `<context>\n${lines.join("\n")}\n</context>`;
  }

  async send(convId: string, text: string, ctx: ChatContext): Promise<void> {
    const stored = await this.loadChat(convId);
    if (!stored) throw new Error("Chat nebyl nalezen.");
    if (this.running.has(convId)) throw new Error("AI ještě odpovídá.");
    const emit: Emit = (e) => this.host.emit({ ...e, convId } as AiEvent);

    const provider = this.host.settings().provider;
    const kind = PROVIDER_MAP[provider].kind;
    const { chat } = stored;
    // Switching providers mid-chat: carry the conversation over as plain text.
    if ((stored.format ?? "anthropic") !== kind) {
      stored.history = plainHistory(chat.messages, kind);
      stored.format = kind;
    }
    const history = stored.history;
    chat.messages.push({ role: "user", parts: [{ kind: "text", text }], context: ctx });
    if (chat.messages.length === 1) chat.title = text.replace(/\s+/g, " ").slice(0, 60);
    const contextText = this.buildContext(ctx);
    if (kind === "anthropic") {
      const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (contextText) userContent.push({ type: "text", text: contextText });
      userContent.push({ type: "text", text });
      history.push({ role: "user", content: userContent });
    } else if (kind === "responses") {
      history.push({
        role: "user",
        content: [...(contextText ? [{ type: "input_text", text: contextText }] : []), { type: "input_text", text }],
      });
    } else {
      history.push({ role: "user", content: contextText ? `${contextText}\n\n${text}` : text });
    }

    const assistant: ChatMessage = { role: "assistant", parts: [] };
    chat.messages.push(assistant);
    const controller = new AbortController();
    this.running.set(convId, controller);
    emit({ type: "turn_start" });

    try {
      await this.loop(stored, assistant, controller.signal, emit, provider);
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || controller.signal.aborted) {
        assistant.parts.push({ kind: "notice", text: "Zastaveno." });
        emit({ type: "notice", message: "Zastaveno." });
        emit({ type: "done", stopReason: "aborted" });
      } else {
        const message = friendlyError(err, provider);
        assistant.parts.push({ kind: "notice", text: `⚠ ${message}` });
        emit({ type: "error", message });
      }
    } finally {
      this.running.delete(convId);
      for (const part of assistant.parts) {
        if (part.kind === "tool" && (part.status === "running" || part.status === "waiting")) part.status = "declined";
      }
      chat.updated = Date.now();
      await this.persist(stored).catch(() => {});
    }
  }

  private systemPrompt(settings: Settings): string {
    return settings.customInstructions.trim()
      ? `${SYSTEM_PROMPT}\n\nThe user's own instructions:\n${settings.customInstructions.trim()}`
      : SYSTEM_PROMPT;
  }

  private async loop(stored: StoredChat, assistant: ChatMessage, signal: AbortSignal, send: Emit, provider: ProviderId): Promise<void> {
    const settings = this.host.settings();
    const vault = this.host.vault();
    if (!vault) throw new Error("Nejdřív otevři trezor.");
    const info = PROVIDER_MAP[provider];
    if (info.kind === "anthropic") return this.loopClaude(stored, assistant, signal, send, vault, settings);
    const model = this.activeModel(provider);
    const ctx = {
      client: this.openaiClient(provider),
      model,
      system: this.systemPrompt(settings),
      effort: settings.effort,
      webSearch: stored.webSearch,
      history: stored.history,
      assistant,
      signal,
      send,
      prices: info.prices?.[model],
      runTool: (id: string, name: string, input: unknown, part: Extract<ChatPart, { kind: "tool" }> | undefined) =>
        this.runTool(id, name, input, part, vault, settings, signal, send),
    };
    if (info.kind === "responses") await runResponsesLoop(ctx);
    else await runChatLoop(ctx);
  }

  private async loopClaude(
    stored: StoredChat,
    assistant: ChatMessage,
    signal: AbortSignal,
    send: Emit,
    vault: Vault,
    settings: Settings,
  ): Promise<void> {
    const client = this.client();
    const model = this.activeModel("anthropic");
    const history = stored.history as Msg[];

    const tools: Anthropic.Beta.BetaToolUnion[] = toolDefinitions();
    if (stored.webSearch && model !== "claude-haiku-5-5") {
      tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
      tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 });
    }
    const system = this.systemPrompt(settings);

    let jsonRetries = 0;
    for (let step = 0; step < 40; step++) {
      const useFallback = FALLBACK_MODELS.has(model);
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 64000,
          system,
          tools,
          messages: history,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: settings.effort },
          cache_control: { type: "ephemeral" },
          ...(useFallback ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] } : {}),
        },
        { signal },
      );

      let current: ChatPart | undefined;
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "text") {
            current = { kind: "text", text: "" };
            assistant.parts.push(current);
          } else if (block.type === "thinking") {
            current = { kind: "thinking", text: "" };
            assistant.parts.push(current);
          } else if (block.type === "tool_use") {
            current = { kind: "tool", id: block.id, name: block.name, status: "running" };
            assistant.parts.push(current);
            send({ type: "tool_start", id: block.id, name: block.name });
          } else if (block.type === "fallback") {
            const note = `Model ${block.from.model} požadavek odmítl, odpověď dokončuje ${block.to.model}.`;
            assistant.parts.push({ kind: "notice", text: note });
            send({ type: "notice", message: note });
            current = undefined;
          } else {
            current = undefined;
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta" && current?.kind === "text") {
            current.text += event.delta.text;
            send({ type: "text", delta: event.delta.text });
          } else if (event.delta.type === "thinking_delta" && current?.kind === "thinking") {
            current.text += event.delta.thinking;
            send({ type: "thinking", delta: event.delta.thinking });
          }
        } else if (event.type === "content_block_stop") {
          send({ type: "block_end" });
        }
      }

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming, unparseable tool JSON rejects finalMessage(); retry that turn a couple of times.
        if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
        assistant.parts = assistant.parts.filter((p) => !(p.kind === "tool" && p.status === "running"));
        continue;
      }
      // Drop empty thinking parts (e.g. redacted or omitted thinking) from the UI.
      assistant.parts = assistant.parts.filter((p) => !(p.kind === "thinking" && !p.text.trim()));

      const usage = message.usage;
      const [pin, pout, pcache] = PROVIDER_MAP.anthropic.prices?.[model] ?? [0, 0, 0];
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      const costUsd = (usage.input_tokens * pin + cacheWrite * pin * 1.25 + cacheRead * pcache + usage.output_tokens * pout) / 1e6;
      send({ type: "usage", input: usage.input_tokens + cacheRead + cacheWrite, output: usage.output_tokens, cacheRead, costUsd });

      for (const block of message.content) {
        if (block.type === "server_tool_use" && block.name === "web_search") {
          const query = String((block.input as { query?: string }).query ?? "");
          assistant.parts.push({ kind: "search", query });
          send({ type: "web_search", query });
        }
      }

      if (message.stop_reason === "refusal") {
        const note = "Claude tuto žádost odmítl zpracovat. Zkus ji formulovat jinak.";
        assistant.parts.push({ kind: "notice", text: note });
        send({ type: "notice", message: note });
        send({ type: "done", stopReason: "refusal" });
        return;
      }

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        // A tool input cut off at max_tokens must never run, and an unanswered tool_use would break the history.
        const note = "Odpověď byla příliš dlouhá a nedokončila se. Zkus požadavek rozdělit na menší části.";
        assistant.parts = assistant.parts.filter((p) => p.kind !== "tool" || p.status !== "running");
        assistant.parts.push({ kind: "notice", text: note });
        send({ type: "notice", message: note });
        send({ type: "done", stopReason: "max_tokens" });
        return;
      }

      history.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (message.stop_reason === "pause_turn") continue;

      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        if (message.stop_reason === "max_tokens") {
          const note = "Odpověď narazila na limit délky.";
          assistant.parts.push({ kind: "notice", text: note });
          send({ type: "notice", message: note });
        }
        send({ type: "done", stopReason: message.stop_reason });
        return;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const part = assistant.parts.find((p): p is Extract<ChatPart, { kind: "tool" }> => p.kind === "tool" && p.id === use.id);
        const result = await this.runTool(use.id, use.name, use.input, part, vault, settings, signal, send);
        results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, is_error: result.isError || undefined });
      }
      history.push({ role: "user", content: results });
      if (signal.aborted) throw new Anthropic.APIUserAbortError();
    }
    throw new Error("Claude udělal příliš mnoho kroků najednou, zastavuji.");
  }

  private async runTool(
    id: string,
    name: string,
    input: unknown,
    part: Extract<ChatPart, { kind: "tool" }> | undefined,
    vault: Vault,
    settings: Settings,
    signal: AbortSignal,
    send: Emit,
  ): Promise<{ content: string; isError: boolean }> {
    const finish = (status: "ok" | "error" | "declined", content: string) => {
      if (part) {
        part.status = status;
        part.result = content;
      }
      send({ type: "tool_result", id: id, ok: status === "ok", result: content });
      return { content, isError: status === "error" };
    };
    if (part) part.input = input;
    send({ type: "tool_input", id: id, input: input });

    const tool = TOOL_MAP[name];
    if (!tool) return finish("error", `Neznámý nástroj: ${name}`);
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) return finish("error", `Neplatný vstup nástroje: ${parsed.error.message}`);
    const env = { vault, dailyFolder: settings.dailyFolder, openNote: this.host.openNote };

    try {
      if (tool.write) {
        const preview = tool.preview!(parsed.data, env);
        if (part) {
          part.summary = preview.summary;
          part.diff = preview.diff;
        }
        if (settings.approvalMode === "ask") {
          if (part) part.status = "waiting";
          send({ type: "approval", id: id, name: name, input: input, summary: preview.summary, diff: preview.diff });
          const ok = await new Promise<boolean>((resolve) => {
            this.approvals.set(id, resolve);
            signal.addEventListener("abort", () => resolve(false), { once: true });
          });
          if (!ok) return finish("declined", "Uživatel tuto změnu zamítl. Nic se nezměnilo.");
        }
      }
      const out = await tool.run(parsed.data, env);
      return finish("ok", out);
    } catch (err) {
      return finish("error", err instanceof Error ? err.message : String(err));
    }
  }

  // ---------- quick actions (one-shot, no tools) ----------

  stopQuick(id: string): void {
    this.quickRuns.get(id)?.abort();
  }

  async quick(req: QuickRequest): Promise<void> {
    const controller = new AbortController();
    this.quickRuns.set(req.id, controller);
    let provider: ProviderId = "anthropic";
    try {
      const settings = this.host.settings();
      provider = settings.provider;
      const instruction =
        req.action === "custom" ? `${QUICK_PROMPTS.custom}\nInstruction: ${req.instruction ?? ""}` : QUICK_PROMPTS[req.action];
      const system =
        "You are a writing tool inside the Vimmi notes app. Return only the requested result as Markdown, with no preamble, no explanations and no surrounding code fences.";
      const prompt = `${instruction}\n\n<text>\n${req.text}\n</text>`;
      const kind = PROVIDER_MAP[provider].kind;
      if (kind !== "anthropic") {
        const text = await streamText(
          this.openaiClient(provider),
          kind,
          { model: this.activeModel(provider), system, prompt, effort: settings.quickEffort, signal: controller.signal },
          (delta) => this.host.emitQuick({ type: "delta", id: req.id, delta }),
        );
        this.host.emitQuick({ type: "done", id: req.id, text: text.trim() });
        return;
      }
      const client = this.client();
      const model = this.activeModel("anthropic");
      const useFallback = FALLBACK_MODELS.has(model);
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 32000,
          system,
          messages: [{ role: "user", content: prompt }],
          output_config: { effort: settings.quickEffort },
          ...(useFallback ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01"] } : {}),
        },
        { signal: controller.signal },
      );
      stream.on("text", (delta) => this.host.emitQuick({ type: "delta", id: req.id, delta }));
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        this.host.emitQuick({ type: "error", id: req.id, message: "Claude tento text odmítl zpracovat." });
        return;
      }
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      this.host.emitQuick({ type: "done", id: req.id, text });
    } catch (err) {
      const message = controller.signal.aborted ? "Zastaveno." : friendlyError(err, provider);
      this.host.emitQuick({ type: "error", id: req.id, message });
    } finally {
      this.quickRuns.delete(req.id);
    }
  }

  /** Checks the key, server and model without spending tokens. */
  async testKey(provider: ProviderId): Promise<{ ok: boolean; message: string }> {
    const info = PROVIDER_MAP[provider];
    try {
      const model = providerModel(provider, this.host.settings().models);
      if (info.kind === "anthropic") {
        const found = await this.client().models.retrieve(model || info.defaultModel);
        return { ok: true, message: `Klíč funguje. Model ${found.display_name} je dostupný.` };
      }
      const ids = await this.listModels(provider);
      if (model && !ids.includes(model)) {
        return { ok: true, message: `Spojení funguje (${ids.length} modelů), ale model „${model}“ v seznamu není. Vyber jiný.` };
      }
      return { ok: true, message: `Spojení funguje. ${ids.length} dostupných modelů${model ? `, „${model}“ mezi nimi` : ""}.` };
    } catch (err) {
      return { ok: false, message: friendlyError(err, provider) };
    }
  }

  /** Live model list from the provider. */
  async listModels(provider: ProviderId): Promise<string[]> {
    const ids: string[] = [];
    if (PROVIDER_MAP[provider].kind === "anthropic") {
      for await (const m of this.client().models.list()) ids.push(m.id);
    } else {
      for await (const m of this.openaiClient(provider).models.list()) ids.push(m.id.replace(/^models\//, ""));
    }
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }
}

/** Rebuilds a provider-format history from the visible chat text (used when switching providers). */
function plainHistory(messages: ChatMessage[], kind: ProviderKind): unknown[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of messages) {
    const text = m.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n").trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last?.role === m.role) last.text += `\n\n${text}`;
    else turns.push({ role: m.role, text });
  }
  if (turns[0]?.role === "assistant") turns.shift();
  // All three API shapes accept plain { role, content: string } messages.
  void kind;
  return turns.map((t) => ({ role: t.role, content: t.text }));
}
