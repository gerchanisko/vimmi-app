/// <reference types="vite/client" />
import type { VimmiApi } from "../electron/preload";

declare global {
  interface Window {
    vimmi: VimmiApi;
  }
}
