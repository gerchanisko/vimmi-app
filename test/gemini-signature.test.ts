// Gemini (OpenAI-compatible API): thought signatures on tool calls must be sent back unchanged.
import { describe, expect, it } from "vitest";
import { runChatLoop } from "../shared/ai/openai-loops";
import type { ChatMessage } from "../shared/types";

type Req = { messages: { role: string; tool_calls?: { extra_content?: { google?: { thought_signature?: string } } }[] }[] };

function fakeClient(rounds: unknown[][]) {
  const requests: Req[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Req) => {
          requests.push(JSON.parse(JSON.stringify(body)));
          const chunks = rounds[requests.length - 1];
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client, requests };
}

const toolCallRound = (signatureOnDelta: boolean) => [
  ...(signatureOnDelta ? [{ choices: [{ index: 0, delta: { role: "assistant", extra_content: { google: { thought_signature: "SIG-1" } } } }] }] : []),
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "list_events", arguments: '{"from":"2026-11-01","to":"2026-11-30"}' },
              ...(signatureOnDelta ? {} : { extra_content: { google: { thought_signature: "SIG-1" } } }),
            },
          ],
        },
      },
    ],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];
const answerRound = [{ choices: [{ index: 0, delta: { content: "V listopadu máš…" }, finish_reason: "stop" }] }];

async function run(rounds: unknown[][], history: unknown[] = [{ role: "user", content: "co mám v listopadu" }], requiresThoughtSignatures = true) {
  const { client, requests } = fakeClient(rounds);
  const assistant: ChatMessage = { role: "assistant", parts: [] } as unknown as ChatMessage;
  await runChatLoop({
    client: client as never,
    model: "gemini-3.8-flash",
    system: "sys",
    effort: "medium",
    webSearch: false,
    history,
    assistant,
    signal: new AbortController().signal,
    send: () => {},
    requiresThoughtSignatures,
    runTool: async () => ({ content: "Nic.", isError: false }),
  });
  return requests;
}

describe("Gemini thought signatures", () => {
  for (const onDelta of [false, true]) {
    it(`sends the signature back (${onDelta ? "on an earlier delta" : "on the tool call"})`, async () => {
      const requests = await run([toolCallRound(onDelta), answerRound]);
      const assistantMsg = requests[1].messages.find((m) => m.role === "assistant" && m.tool_calls)!;
      expect(assistantMsg.tool_calls![0].extra_content?.google?.thought_signature).toBe("SIG-1");
    });
  }

  it("old chats without signatures get Google's placeholder", async () => {
    const history = [
      { role: "user", content: "přidej úkol" },
      { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "add_task", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "old", content: "ok" },
      { role: "user", content: "díky" },
    ];
    const requests = await run([answerRound], history);
    expect(requests[0].messages.find((m) => m.tool_calls)!.tool_calls![0].extra_content?.google?.thought_signature).toBe("skip_thought_signature_validator");
  });

  it("other providers get no extra fields", async () => {
    const history = [{ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "a", arguments: "{}" } }] }, { role: "tool", tool_call_id: "x", content: "ok" }];
    const requests = await run([answerRound], history, false);
    expect(requests[0].messages.find((m) => m.tool_calls)!.tool_calls![0].extra_content).toBeUndefined();
  });
});
