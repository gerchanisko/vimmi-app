// End-to-end smoke test: launches the real Electron app against a temporary vault and a
// mock Anthropic API, clicks through the main features and saves screenshots.
// Usage: npm run build && node test/smoke.mjs [screenshot-dir]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const shots = path.resolve(process.argv[2] ?? "test/screenshots");
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vimmi-smoke-"));
const userData = path.join(tmp, "user-data");
const vaultDir = path.join(tmp, "Trezor");
fs.mkdirSync(userData, { recursive: true });

// ---------- mock Anthropic API ----------
const requests = [];
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
const chatRequests = [];
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
const responsesRequests = [];
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

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
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
const apiUrl = `http://127.0.0.1:${server.address().port}`;

// ---------- launch ----------
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ vaultPath: vaultDir, recentVaults: [vaultDir], theme: "light", approvalMode: "ask" }));
// Create the sample vault the same way the app does on first run.
const { sampleNotes } = await import("../dist-electron/sample-for-test.cjs");
{
  for (const [rel, content] of Object.entries(sampleNotes(new Date().toISOString().slice(0, 10)))) {
    fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, rel), content);
  }
}

const app = await electron.launch({
  // CI Linux runners block the Chromium sandbox; desktop installs keep it.
  args: [".", ...(process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [])],
  env: {
    ...process.env,
    VIMMI_USER_DATA: userData,
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_BASE_URL: apiUrl,
    OPENAI_API_KEY: "sk-openai-test",
    VIMMI_OPENAI_BASE_URL: `${apiUrl}/v1`,
    // Updates: pretend to be an install.sh install, with a fake release feed and installer.
    VIMMI_UPDATE_METHOD: "script",
    VIMMI_UPDATE_FEED: `${apiUrl}/release/latest`,
    VIMMI_UPDATE_COMMAND: "echo instaluji; sleep 1",
  },
});
const page = await app.firstWindow();
await page.setViewportSize?.({ width: 1360, height: 860 }).catch(() => {});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const read = (rel) => fs.readFileSync(path.join(vaultDir, rel), "utf8");

try {
  await step("workspace opens with welcome note", async () => {
    await page.waitForSelector(".workspace", { timeout: 15000 });
    await page.waitForSelector(".cm-content");
    await page.waitForTimeout(400);
    await shot("01-welcome-note");
  });

  await step("editing autosaves to disk", async () => {
    await page.click(".cm-content");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nNapsáno ve smoke testu [[Nápady]] #test");
    await page.waitForTimeout(900);
    if (!read("Vítej ve Vimmi.md").includes("Napsáno ve smoke testu")) throw new Error("not saved");
  });

  await step("wikilink autocomplete", async () => {
    await page.keyboard.type("\n[[Ces");
    await page.waitForSelector(".cm-tooltip-autocomplete");
    await shot("02-autocomplete");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    if (!read("Vítej ve Vimmi.md").includes("[[Cesty]]")) throw new Error("completion not applied");
  });

  await step("spotlight search (Ctrl+K)", async () => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".palette");
    await page.keyboard.type("krkonose");
    await page.waitForTimeout(400);
    await shot("03-spotlight");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const title = await page.locator(".tab.active .tab-label").textContent();
    if (!/Cesty|Nápady/.test(title)) throw new Error(`opened ${title}`);
  });

  await step("reading mode renders links and tasks", async () => {
    await page.keyboard.press("Control+e");
    await page.locator(".tab-pane:not([hidden]) article.markdown a.wikilink").first().waitFor();
    await shot("04-reading");
    await page.keyboard.press("Control+e");
  });

  await step("Today view + toggling a task writes the file", async () => {
    await page.click("text=Dnes >> nth=0");
    await page.locator(".tab-pane:not([hidden]) .today-view").waitFor();
    await shot("05-today");
    await page.click("text=Úkoly >> nth=0");
    const pane = page.locator(".tab-pane:not([hidden])");
    await pane.locator(".task-row").first().waitFor();
    const row = pane.locator(".task-row", { hasText: "Napsat sekci" }).first();
    await row.locator("input[type=checkbox]").click();
    await page.waitForTimeout(500);
    if (!/- \[x\] Napsat sekci Časté otázky/.test(read("Projekty/Web Vimmi.md"))) throw new Error("task not toggled");
    await shot("06-tasks");
  });

  await step("projects view", async () => {
    await page.click(".side-nav >> text=Projekty");
    await page.locator(".tab-pane:not([hidden]) .project-card").first().waitFor();
    await shot("07-projects");
  });

  await step("graph view", async () => {
    await page.click(".side-nav >> text=Graf");
    await page.locator(".tab-pane:not([hidden]) .graph-canvas canvas").waitFor();
    await page.waitForTimeout(1500);
    await shot("08-graph");
  });

  await step("calendar: new event, drag to another time, month and list views", async () => {
    await page.click(".side-nav >> text=Kalendář");
    const cal = page.locator(".tab-pane:not([hidden]) .calendar");
    await cal.locator(".segmented >> text=Týden").click();
    await cal.locator(".cal-toolbar >> text=Událost").click();
    await page.fill(".event-dialog .event-title-input", "Zubař");
    await page.fill(".event-dialog input[placeholder='Místo']", "Poliklinika");
    await page.click(".event-dialog >> text=Uložit");
    await page.waitForTimeout(500);
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const file = path.join("Kalendář", `${iso} Zubař.md`);
    if (!/start: "09:00"[\s\S]*location: Poliklinika/.test(read(file))) throw new Error(`event not saved:\n${read(file)}`);
    const ev = cal.locator(".cal-event", { hasText: "Zubař" });
    await ev.scrollIntoViewIfNeeded();
    const box = await ev.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 34, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2, box.y + 58, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    if (!read(file).includes('start: "10:00"')) throw new Error(`drag did not move the event:\n${read(file)}`);
    await shot("19-calendar-week");
    await cal.locator(".segmented >> text=Měsíc").click();
    await cal.locator(".cal-month .cal-chip", { hasText: "Zubař" }).waitFor();
    await shot("20-calendar-month");
    await cal.locator(".segmented >> text=Seznam").click();
    await cal.locator(".cal-agenda-item", { hasText: "Zubař" }).click();
    await page.waitForSelector(".event-dialog");
    await shot("21-calendar-event");
    await page.keyboard.press("Escape");
    await cal.locator(".segmented >> text=Týden").click();
  });

  await step("command palette (Ctrl+P)", async () => {
    await page.keyboard.press("Control+p");
    await page.keyboard.type("denni");
    await page.waitForTimeout(200);
    await shot("09-commands");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (!fs.existsSync(path.join(vaultDir, "Deník", `${iso}.md`))) throw new Error("daily note missing");
  });

  await step("AI chat: tools, approval, file change", async () => {
    await page.click(".side-scroll >> text=Nápady");
    await page.keyboard.press("Control+j");
    await page.waitForSelector(".chat-input textarea");
    await page.fill(".chat-input textarea", "Přidej do nápadů aplikaci na plánování výletů");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".approval", { timeout: 10000 });
    await page.waitForTimeout(200);
    await shot("10-ai-approval");
    await page.click(".approval >> text=Povolit");
    await page.waitForSelector("text=Hotovo – přidal jsem", { timeout: 10000 });
    await page.waitForTimeout(300);
    await shot("11-ai-done");
    if (!read("Nápady.md").includes("Aplikace na plánování výletů (od AI)")) throw new Error("AI edit not written");
    const first = requests.find((r) => r.tools);
    if (first.model !== "claude-sonnet-5-5") throw new Error(`model ${first.model}`);
    if (first.fallbacks !== "default") throw new Error("fallbacks not set");
    if (first.thinking?.type !== "adaptive") throw new Error("thinking not adaptive");
    if (!JSON.stringify(first.messages[0].content).includes("<open_note")) throw new Error("note context missing");
  });

  await step("AI quick action (summarize)", async () => {
    await page.locator(".tab-pane:not([hidden]) .note-actions .ai-btn").click();
    await page.click(".menu >> text=Shrnout");
    await page.waitForSelector(".quick-panel >> text=Shrnutí:", { timeout: 10000 });
    await shot("12-ai-quick");
    await page.click(".quick-panel >> text=Zahodit");
  });

  await step("settings → AI", async () => {
    await page.keyboard.press("Control+,");
    await page.click(".settings-nav >> text=AI");
    await page.waitForSelector(".provider-grid");
    await page.click("text=Otestovat spojení");
    await page.waitForSelector("text=Klíč funguje");
    await shot("13-settings-ai");
    await page.keyboard.press("Escape");
  });

  await step("custom OpenAI-compatible provider: tools, automatic changes", async () => {
    await page.keyboard.press("Control+,");
    await page.click(".settings-nav >> text=AI");
    await page.click(".provider-card >> text=Vlastní");
    await page.fill(".provider-settings .url-input >> nth=0", `${apiUrl}/v1`);
    await page.click(".segmented >> text=Automaticky");
    await page.click(".provider-settings >> text=Načíst modely");
    await page.click(".model-row >> text=mock-model");
    await page.waitForTimeout(200);
    await shot("15-provider-settings");
    await page.keyboard.press("Escape");
    await page.click(".ai-chat button[title='Nový chat']");
    await page.fill(".chat-input textarea", "Přidej úkol koupit mapu");
    await page.keyboard.press("Enter");
    // Automatic mode: no approval card, the change is written right away.
    await page.waitForSelector("text=Hotovo (compat)", { timeout: 10000 });
    if (await page.locator(".approval").count()) throw new Error("approval shown in automatic mode");
    await shot("16-custom-provider-chat");
    if (!/- \[ \] Koupit mapu Krkonoš !2/.test(read("Cesty.md"))) throw new Error("compat tool not applied");
    const req = chatRequests.find((r) => r.tools);
    if (req.model !== "mock-model" || req.messages[0].role !== "system") throw new Error("bad compat request");
    if (!chatRequests.some((r) => r.messages.some((m) => m.role === "tool"))) throw new Error("tool result not sent back");
  });

  await step("OpenAI provider (Responses API): tools + approval + quick action", async () => {
    await page.keyboard.press("Control+,");
    await page.click(".settings-nav >> text=AI");
    await page.click(".segmented >> text=Ptát se");
    await page.keyboard.press("Escape");
    await page.click(".model-switch");
    await page.click(".menu >> text=OpenAI");
    await page.waitForTimeout(200);
    await page.click(".ai-chat button[title='Nový chat']");
    await page.fill(".chat-input textarea", "Vytvoř poznámku z OpenAI");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".approval", { timeout: 10000 });
    await page.click(".approval >> text=Povolit");
    await page.waitForSelector("text=Vytvořil jsem", { timeout: 10000 });
    await shot("17-openai-chat");
    if (!read("Nápady/Z OpenAI.md").includes("Responses API")) throw new Error("responses tool not applied");
    const req = responsesRequests.find((r) => r.tools);
    if (req.model !== "gpt-6.1-sol" || req.store !== false) throw new Error(`bad responses request ${req.model}`);
    if (!responsesRequests.some((r) => Array.isArray(r.input) && r.input.some((i) => i.type === "function_call_output"))) throw new Error("function output not sent");
    await page.locator(".tab-pane:not([hidden]) .note-actions .ai-btn").click();
    await page.click(".menu >> text=Shrnout");
    await page.waitForSelector(".quick-panel >> text=Shrnutí (OpenAI)", { timeout: 10000 });
    await page.click(".quick-panel >> text=Zahodit");
  });

  await step("finds a new version, installs it in the background and offers a restart", async () => {
    await page.keyboard.press("Control+,");
    await page.click(".settings-nav >> text=O aplikaci");
    // The automatic check (15 s after start) may already have found it.
    const check = page.locator("text=Zkontrolovat aktualizace");
    if (await check.isVisible()) await check.click();
    await page.waitForSelector(".update-banner >> text=Vimmi 9.9.9 je připravené", { timeout: 20000 });
    await page.waitForSelector("text=Restartovat a aktualizovat");
    await shot("18-update-ready");
    await page.keyboard.press("Escape");
    await page.click(".update-banner button[aria-label='Později']");
  });

  await step("dark theme", async () => {
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await page.click(".side-scroll >> text=Vítej ve Vimmi");
    await page.waitForTimeout(300);
    await shot("14-dark");
  });

  if (errors.length) throw new Error(`renderer errors:\n${errors.join("\n")}`);
  console.log(`\nAll good. Screenshots in ${shots}`);
} catch (err) {
  await shot("failure").catch(() => {});
  console.error("\nFAILED:", err.message);
  if (errors.length) console.error("Renderer errors:\n" + errors.join("\n"));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
