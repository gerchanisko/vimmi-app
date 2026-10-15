// "Otestovat spojení" with NVIDIA: a listed model the account cannot use is replaced by one that works.
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../shared/ai/agent";
import { DEFAULT_SETTINGS } from "../shared/types";

let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/models")) {
        res.end(JSON.stringify({ data: ["moonshotai/kimi-k2.6", "z-ai/glm-5.3", "deepseek-ai/deepseek-v4.1-flash", "nvidia/nv-embedqa-e5-v5"].map((id) => ({ id })) }));
        return;
      }
      const model = JSON.parse(body).model as string;
      const ok = () => res.end(JSON.stringify({ id: "1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Ahoj" }, finish_reason: "stop" }] }));
      if (model === "z-ai/glm-5.3") {
        setTimeout(ok, 3500); // works, but slowly (busy free server)
        return;
      }
      if (model !== "deepseek-ai/deepseek-v4.1-flash") {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: 404, title: "Not Found", detail: "Function 'abc': Not found for account 'xyz'" }));
        return;
      }
      res.end(JSON.stringify({ id: "1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Ahoj" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.VIMMI_NVIDIA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => {
  server.close();
  delete process.env.VIMMI_NVIDIA_BASE_URL;
});

describe("NVIDIA", () => {
  const agent = (model: string) =>
    new Agent({
      vault: () => undefined,
      settings: () => ({ ...DEFAULT_SETTINGS, provider: "nvidia", models: { nvidia: model } }),
      apiKey: () => "nvapi-test",
      emit: () => {},
      emitQuick: () => {},
      openNote: () => {},
    });

  it("hides non-chat models and switches to a model the account can use", async () => {
    expect(await agent("").listModels("nvidia")).not.toContain("nvidia/nv-embedqa-e5-v5");
    const r = await agent("moonshotai/kimi-k2.6").testKey("nvidia");
    expect(r).toMatchObject({ ok: true, model: "deepseek-ai/deepseek-v4.1-flash" });
  });

  it("switches from a working but much slower model to the fastest one", async () => {
    const r = await agent("z-ai/glm-5.3").testKey("nvidia");
    expect(r.model).toBe("deepseek-ai/deepseek-v4.1-flash");
    expect(r.message).toContain("výrazně pomalejší");
    expect(r.message).toMatch(/glm-5\.3 3\.\d s/);
  });

  it("explains the account error in the chat", async () => {
    const { friendlyError } = await import("../shared/ai/agent");
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey: "x", baseURL: process.env.VIMMI_NVIDIA_BASE_URL });
    const err = await client.chat.completions.create({ model: "moonshotai/kimi-k2.6", messages: [{ role: "user", content: "hi" }] }).catch((e) => e);
    expect(friendlyError(err, "nvidia")).toContain("Otestovat spojení");
  });
});
