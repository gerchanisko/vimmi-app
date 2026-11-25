/// <reference types="vite/client" />
import type { VimmiApi } from "../electron/preload";
import type { ClaudeConnectApi } from "../shared/types";

declare global {
  interface Window {
    /** `claude` only in the Rust desktop app: connecting Vimmi to Claude Code / Claude Desktop (MCP). */
    vimmi: VimmiApi & { claude?: ClaudeConnectApi };
  }
}
