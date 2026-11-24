import { describe, expect, it } from "vitest";
import { routedThroughRust } from "../tauri/fetch-route";

describe("which requests the desktop app sends through Rust", () => {
  it("routes other sites (AI, GitHub, calendars, Ollama)", () => {
    expect(routedThroughRust("https://api.anthropic.com/v1/messages", "tauri://localhost")).toBe(true);
    expect(routedThroughRust("https://api.github.com/user", "http://tauri.localhost")).toBe(true);
    expect(routedThroughRust("http://localhost:11434/v1/chat/completions", "http://tauri.localhost")).toBe(true);
    expect(routedThroughRust("http://127.0.0.1:8080/x.ics", "tauri://localhost")).toBe(true);
  });

  it("never routes Tauri's own addresses (Windows IPC would loop forever)", () => {
    expect(routedThroughRust("http://ipc.localhost/plugin%3Ahttp%7Cfetch", "http://tauri.localhost")).toBe(false);
    expect(routedThroughRust("http://vimmi-file.localhost/Fotka.png", "http://tauri.localhost")).toBe(false);
    expect(routedThroughRust("http://tauri.localhost/assets/app.js", "http://tauri.localhost")).toBe(false);
    expect(routedThroughRust("ipc://localhost/env_info", "tauri://localhost")).toBe(false);
    expect(routedThroughRust("tauri://localhost/index.html", "tauri://localhost")).toBe(false);
  });
});
