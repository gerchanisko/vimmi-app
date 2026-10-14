// Agent loops for non-Claude providers, using the official OpenAI SDK:
// - OpenAI itself via the Responses API (newer GPT models only support tools well there)
// - Gemini, OpenRouter, Ollama and custom servers via OpenAI-compatible Chat Completions
import OpenAI from "openai";
import type { AiEvent, ChatMessage, ChatPart, Effort } from "../types";
import { functionSchemas } from "./tools";

type EventBody = AiEvent extends infer E ? (E extends AiEvent ? Omit<E, "convId"> : never) : never;
type ToolPart = Extract<ChatPart, { kind: "tool" }>;

export interface LoopContext {
  client: OpenAI;
  model: string;
  system: string;
  effort: Effort;
  webSearch: boolean;
  /** Provider-format history; the loop appends to it. */
  history: unknown[];
  assistant: ChatMessage;
  signal: AbortSignal;
  send: (e: EventBody) => void;
  /** Runs a vault tool (with approval when needed) and updates the UI part. */
  runTool: (id: string, name: string, input: unknown, part: ToolPart | undefined) => Promise<{ content: string; isError: boolean }>;
  prices?: [number, number, number];
}

const MAX_STEPS = 40;

function cost(prices: [number, number, number] | undefined, input: number, output: number, cached: number): number | null {
  if (!prices) return null;
  return ((input - cached) * prices[0] + cached * prices[2] + output * prices[1]) / 1e6;
}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: raw.trim() ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false, error: `Argumenty nástroje nejsou platný JSON: ${raw.slice(0, 200)}` };
  }
}

function findTool(assistant: ChatMessage, id: string): ToolPart | undefined {
  return assistant.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === id);
}

function finishText(assistant: ChatMessage, send: LoopContext["send"]) {
  const last = assistant.parts.at(-1);
  if (last && (last.kind === "text" || last.kind === "thinking") && !last.closed) {
    last.closed = true;
    send({ type: "block_end" });
  }
}

function appendDelta(assistant: ChatMessage, kind: "text" | "thinking", delta: string, send: LoopContext["send"]) {
  const last = assistant.parts.at(-1);
  if (last && last.kind === kind && !last.closed) last.text += delta;
  else {
    finishText(assistant, send);
    assistant.parts.push({ kind, text: delta });
  }
  send({ type: kind, delta } as EventBody);
}

// ---------------------------------------------------------------- Responses API (OpenAI)

export async function runResponsesLoop(ctx: LoopContext): Promise<void> {
  const { client, assistant, send, history } = ctx;
  const tools: OpenAI.Responses.Tool[] = functionSchemas().map((f) => ({
    type: "function",
    name: f.name,
    description: f.description,
    parameters: f.parameters,
    strict: false,
  }));
  if (ctx.webSearch) tools.push({ type: "web_search" });

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.responses.stream(
      {
        model: ctx.model,
        instructions: ctx.system,
        input: history as OpenAI.Responses.ResponseInput,
        tools,
        reasoning: { effort: ctx.effort, summary: "auto" },
        // Stateless: nothing is stored at OpenAI; reasoning is passed back encrypted.
        store: false,
        include: ["reasoning.encrypted_content"],
      },
      { signal: ctx.signal },
    );

    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          appendDelta(assistant, "text", event.delta, send);
          break;
        case "response.reasoning_summary_text.delta":
          appendDelta(assistant, "thinking", event.delta, send);
          break;
        case "response.output_item.added":
          if (event.item.type === "function_call") {
            finishText(assistant, send);
            assistant.parts.push({ kind: "tool", id: event.item.call_id, name: event.item.name, status: "running" });
            send({ type: "tool_start", id: event.item.call_id, name: event.item.name });
          }
          break;
        case "response.output_item.done":
          finishText(assistant, send);
          if (event.item.type === "web_search_call") {
            const action = (event.item as { action?: { query?: string } }).action;
            if (action?.query) {
              assistant.parts.push({ kind: "search", query: action.query });
              send({ type: "web_search", query: action.query });
            }
          }
          break;
      }
    }
    const response = await stream.finalResponse();
    finishText(assistant, send);
    assistant.parts = assistant.parts.filter((p) => !(p.kind === "thinking" && !p.text.trim()));

    const usage = response.usage;
    if (usage) {
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      send({ type: "usage", input: usage.input_tokens, output: usage.output_tokens, cacheRead: cached, costUsd: cost(ctx.prices, usage.input_tokens, usage.output_tokens, cached) });
    }

    // Output items go back as input next turn (stateless conversation).
    history.push(...(response.output as unknown[]));

    const calls = response.output.filter((o) => o.type === "function_call") as unknown as OpenAI.Responses.ResponseFunctionToolCall[];
    if (response.status === "incomplete") {
      const why = response.incomplete_details?.reason === "content_filter" ? "Model odpověď zablokoval filtrem obsahu." : "Odpověď narazila na limit délky.";
      assistant.parts.push({ kind: "notice", text: why });
      send({ type: "notice", message: why });
      // Unanswered function calls would break the next request; drop them from history.
      if (calls.length) history.splice(history.length - response.output.length, response.output.length);
      send({ type: "done", stopReason: "incomplete" });
      return;
    }
    if (!calls.length) {
      send({ type: "done", stopReason: "end_turn" });
      return;
    }
    for (const call of calls) {
      const part = findTool(assistant, call.call_id);
      const args = parseArgs(call.arguments);
      const result = args.ok
        ? await ctx.runTool(call.call_id, call.name, args.value, part)
        : { content: args.error, isError: true };
      history.push({ type: "function_call_output", call_id: call.call_id, output: result.content });
    }
    if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
  }
  throw new Error("Model udělal příliš mnoho kroků najednou, zastavuji.");
}

// ---------------------------------------------------------------- Chat Completions (compatible servers)

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export async function runChatLoop(ctx: LoopContext): Promise<void> {
  const { client, assistant, send, history } = ctx;
  const tools: OpenAI.Chat.ChatCompletionTool[] = functionSchemas().map((f) => ({
    type: "function",
    function: { name: f.name, description: f.description, parameters: f.parameters },
  }));

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = await client.chat.completions.create(
      {
        model: ctx.model,
        messages: [{ role: "system", content: ctx.system }, ...(history as OpenAI.Chat.ChatCompletionMessageParam[])],
        tools,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: ctx.signal },
    );

    let text = "";
    let finish: string | null = null;
    const calls: PendingCall[] = [];
    for await (const chunk of stream) {
      if (chunk.usage) {
        const cached = (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0;
        send({
          type: "usage",
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
          cacheRead: cached,
          costUsd: cost(ctx.prices, chunk.usage.prompt_tokens, chunk.usage.completion_tokens, cached),
        });
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; reasoning?: string };
      // Several servers (DeepSeek, Ollama, OpenRouter) stream reasoning in a separate field.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) appendDelta(assistant, "thinking", reasoning, send);
      if (delta.content) {
        text += delta.content;
        appendDelta(assistant, "text", delta.content, send);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        if (!calls[i]) calls[i] = { id: tc.id ?? `call_${step}_${i}`, name: "", args: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) {
          const first = !calls[i].name;
          calls[i].name += tc.function.name;
          if (first) {
            finishText(assistant, send);
            assistant.parts.push({ kind: "tool", id: calls[i].id, name: calls[i].name, status: "running" });
            send({ type: "tool_start", id: calls[i].id, name: calls[i].name });
          }
        }
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    finishText(assistant, send);
    assistant.parts = assistant.parts.filter((p) => !(p.kind === "thinking" && !p.text.trim()));
    const pending = calls.filter(Boolean);

    if (finish === "length" && pending.length) {
      const note = "Odpověď byla příliš dlouhá a nedokončila se. Zkus požadavek rozdělit na menší části.";
      assistant.parts = assistant.parts.filter((p) => p.kind !== "tool" || p.status !== "running");
      assistant.parts.push({ kind: "notice", text: note });
      send({ type: "notice", message: note });
      send({ type: "done", stopReason: "max_tokens" });
      return;
    }

    history.push({
      role: "assistant",
      content: text || null,
      ...(pending.length
        ? { tool_calls: pending.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) }
        : {}),
    });

    if (!pending.length) {
      if (finish === "length") {
        assistant.parts.push({ kind: "notice", text: "Odpověď narazila na limit délky." });
        send({ type: "notice", message: "Odpověď narazila na limit délky." });
      }
      if (finish === "content_filter") {
        assistant.parts.push({ kind: "notice", text: "Model odpověď zablokoval filtrem obsahu." });
        send({ type: "notice", message: "Model odpověď zablokoval filtrem obsahu." });
      }
      send({ type: "done", stopReason: finish });
      return;
    }

    for (const call of pending) {
      const part = findTool(assistant, call.id);
      const args = parseArgs(call.args);
      const result = args.ok ? await ctx.runTool(call.id, call.name, args.value, part) : { content: args.error, isError: true };
      history.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
    if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
  }
  throw new Error("Model udělal příliš mnoho kroků najednou, zastavuji.");
}

// ---------------------------------------------------------------- one-shot text (quick actions)

export async function streamText(
  client: OpenAI,
  kind: "responses" | "chat",
  opts: { model: string; system: string; prompt: string; effort: Effort; signal: AbortSignal },
  onDelta: (delta: string) => void,
): Promise<string> {
  if (kind === "responses") {
    const stream = client.responses.stream(
      { model: opts.model, instructions: opts.system, input: opts.prompt, reasoning: { effort: opts.effort }, store: false },
      { signal: opts.signal },
    );
    stream.on("response.output_text.delta", (e) => onDelta(e.delta));
    const response = await stream.finalResponse();
    return response.output_text;
  }
  const stream = await client.chat.completions.create(
    { model: opts.model, messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.prompt }], stream: true },
    { signal: opts.signal },
  );
  let text = "";
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content;
    if (d) {
      text += d;
      onDelta(d);
    }
  }
  return text;
}

/** Turns SDK errors from OpenAI-compatible servers into short Czech messages. */
export function friendlyOpenAIError(err: unknown, providerName: string): string | null {
  if (err instanceof OpenAI.AuthenticationError) return `${providerName}: API klíč je neplatný. Zkontroluj ho v Nastavení → AI.`;
  if (err instanceof OpenAI.PermissionDeniedError) return `${providerName}: klíč nemá přístup k tomuto modelu.`;
  if (err instanceof OpenAI.NotFoundError) return `${providerName}: model nebo adresa serveru nebyla nalezena. Vyber jiný model v Nastavení → AI.`;
  if (err instanceof OpenAI.RateLimitError) return `${providerName}: limit požadavků nebo kreditu je vyčerpaný. Zkus to za chvíli (bezplatné modely mají denní limity).`;
  if (err instanceof OpenAI.BadRequestError) {
    if (/tool|function/i.test(err.message)) return `${providerName}: tento model asi nepodporuje nástroje. Vyber jiný model. (${err.message})`;
    return `${providerName}: požadavek byl odmítnut: ${err.message}`;
  }
  if (err instanceof OpenAI.InternalServerError) return `${providerName} má teď potíže. Zkus to za chvíli znovu.`;
  if (err instanceof OpenAI.APIConnectionError) return `Nepodařilo se spojit s ${providerName}. Běží server a jsi připojený k internetu?`;
  if (err instanceof OpenAI.APIError) return `${providerName}: chyba API (${err.status}): ${err.message}`;
  return null;
}
