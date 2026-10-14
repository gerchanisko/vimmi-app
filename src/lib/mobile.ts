// Phone-sized layout detection (the web app on iPhone, or any narrow window).
import { useSyncExternalStore } from "react";

const query = typeof window !== "undefined" ? window.matchMedia("(max-width: 760px)") : null;

export function isMobile(): boolean {
  return Boolean(query?.matches);
}

export function useMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      query?.addEventListener("change", cb);
      return () => query?.removeEventListener("change", cb);
    },
    isMobile,
  );
}

/** Running as an app from the home screen (not inside Safari's browser UI). */
export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}
