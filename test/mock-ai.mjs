// Mock AI and download servers shared by the end-to-end tests (Electron smoke, Tauri smoke):
// Anthropic Messages, OpenAI Chat Completions and Responses, a Google-style .ics feed and a release feed.
import http from "node:http";

// ---------- mock Anthropic API ----------
export const requests = [];
function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function message(blocks, stop) {
  const ev = [
    {
      type: "message_start",
      message: { id: "msg_mock", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 0, cache_read_input_tokens: 900 } },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.text } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
    } else if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const chunk of b.text.match(/.{1,12}/gs)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 80 } });
  ev.push({ type: "message_stop" });
  return ev;
}
// --- OpenAI-compatible Chat Completions mock (Gemini, OpenRouter, Ollama, custom) ---
export const chatRequests = [];
function chatCompletions(json, res) {
  chatRequests.push(json);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const last = json.messages.at(-1);
  if (!json.tools) {
    chunk({ role: "assistant", content: "**Shrnutí (compat):** krátké." });
    chunk({}, "stop");
  } else if (last.role === "user") {
    chunk({ role: "assistant", reasoning_content: "Přidám úkol." });
    chunk({ content: "Přidám úkol do cest." });
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "add_task", arguments: "" } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"text":"Koupit mapu Krkonoš",' } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"note":"Cesty","priority":2}' } }] });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: "Hotovo (compat) – úkol je v [[Cesty]]." });
    chunk({}, "stop");
  }
  res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: json.model, choices: [], usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

// --- OpenAI Responses API mock ---
export const responsesRequests = [];
function responses(json, res) {
  responsesRequests.push(json);
  res.writeHead(200, { "content-type": "text/event-stream" });
  let seq = 0;
  const ev = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: seq++ })}\n\n`);
  const base = { id: "resp_1", object: "response", created_at: 1, model: json.model, status: "in_progress", output: [], tools: [], parallel_tool_calls: true, tool_choice: "auto", error: null, incomplete_details: null, instructions: null, metadata: {}, temperature: 1, top_p: 1 };
  ev({ type: "response.created", response: base });
  const input = Array.isArray(json.input) ? json.input : [];
  const hasResult = input.some((i) => i.type === "function_call_output");
  let output;
  if (!json.tools) {
    output = [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "**Shrnutí (OpenAI):** krátké.", annotations: [] }] }];
  } else if (!hasResult) {
    output = [{ type: "function_call", id: "fc1", call_id: "call_r1", name: "create_note", arguments: JSON.stringify({ path: "Nápady/Z OpenAI.md", content: "# Z OpenAI\n\nVytvořeno přes Responses API." }), status: "completed" }];
  } else {
    output = [{ type: "message", id: "m2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Vytvořil jsem [[Z OpenAI]].", annotations: [] }] }];
  }
  output.forEach((item, i) => {
    if (item.type === "message") {
      ev({ type: "response.output_item.added", output_index: i, item: { ...item, content: [], status: "in_progress" } });
      ev({ type: "response.content_part.added", output_index: i, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      ev({ type: "response.output_text.delta", output_index: i, item_id: item.id, content_index: 0, delta: item.content[0].text, logprobs: [] });
      ev({ type: "response.output_text.done", output_index: i, item_id: item.id, content_index: 0, text: item.content[0].text, logprobs: [] });
      ev({ type: "response.content_part.done", output_index: i, item_id: item.id, content_index: 0, part: item.content[0] });
    } else {
      ev({ type: "response.output_item.added", output_index: i, item: { ...item, arguments: "", status: "in_progress" } });
      ev({ type: "response.function_call_arguments.delta", output_index: i, item_id: item.id, delta: item.arguments });
      ev({ type: "response.function_call_arguments.done", output_index: i, item_id: item.id, arguments: item.arguments, name: item.name });
    }
    ev({ type: "response.output_item.done", output_index: i, item });
  });
  ev({ type: "response.completed", response: { ...base, status: "completed", output, usage: { input_tokens: 800, output_tokens: 60, total_tokens: 860, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  res.end();
}

export const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/private-secret/basic.ics") {
      // A Google-style calendar: today's meeting and a weekly repeat.
      const day = new Date();
      const ymd = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, "0")}${String(day.getDate()).padStart(2, "0")}`;
      res.writeHead(200, { "content-type": "text/calendar" });
      res.end(
        [
          "BEGIN:VCALENDAR",
          "X-WR-CALNAME:Google",
          "BEGIN:VEVENT",
          "UID:g1",
          "DTSTAMP:20261015T100000Z",
          "SUMMARY:Porada z Googlu",
          `DTSTART;TZID=Europe/Prague:${ymd}T130000`,
          `DTEND;TZID=Europe/Prague:${ymd}T140000`,
          "LOCATION:Zasedačka 2",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
      );
      return;
    }
    if (req.url === "/release/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tag_name: "v9.9.9" }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/v1/models/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", type: "model", created_at: "2026-01-01T00:00:00Z" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }, { id: "mock-free:free", object: "model" }] }));
      return;
    }
    const json = JSON.parse(body || "{}");
    if (req.url === "/v1/chat/completions") return chatCompletions(json, res);
    if (req.url === "/v1/responses") return responses(json, res);
    requests.push(json);
    if (!json.tools) {
      sse(res, message([{ type: "text", text: "**Shrnutí:** Poznámka popisuje, jak Vimmi funguje." }], "end_turn"));
      return;
    }
    const last = json.messages.at(-1);
    const result = Array.isArray(last.content) ? last.content.find((c) => c.type === "tool_result") : null;
    if (!result) {
      sse(res, message([{ type: "thinking", text: "Uživatel chce přidat nápad. Nejdřív najdu poznámku." }, { type: "text", text: "Podívám se do tvých nápadů." }, { type: "tool_use", id: "toolu_1", name: "search_notes", input: { query: "nápady" } }], "tool_use"));
    } else if (result.tool_use_id === "toolu_1") {
      sse(res, message([{ type: "tool_use", id: "toolu_2", name: "append_to_note", input: { path: "Nápady", text: "- Aplikace na plánování výletů (od AI)" } }], "tool_use"));
    } else {
      sse(res, message([{ type: "text", text: "Hotovo – přidal jsem nápad do [[Nápady]]." }], "end_turn"));
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
export const apiUrl = `http://127.0.0.1:${server.address().port}`;
