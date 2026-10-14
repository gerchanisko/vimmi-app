// Event reminders: checks every 30 s and shows a system notification (plus an in-app toast).
import { dueReminders, eventsFromNotes } from "../../shared/calendar";
import { getState, openView, toast } from "./store";

const KEY = "vimmi:reminders-checked";

function lastCheck(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    // Never fire reminders older than 10 minutes (e.g. after the app was closed for a day).
    return Math.max(v || 0, Date.now() - 10 * 60_000);
  } catch {
    return Date.now();
  }
}

function check(): void {
  const notes = getState().snapshot?.notes;
  if (!notes) return;
  const since = lastCheck();
  const now = Date.now();
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    /* ignore */
  }
  for (const o of dueReminders(eventsFromNotes(notes), since, now)) {
    const when = o.event.remind ? `za ${o.event.remind >= 60 ? `${Math.round(o.event.remind / 60)} h` : `${o.event.remind} min`}` : "teď";
    const body = `${o.event.start}–${o.event.end} (${when})${o.event.location ? ` · ${o.event.location}` : ""}`;
    toast(`${o.event.title}: ${body}`);
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(o.event.title, { body, tag: `${o.event.path}:${o.date}` });
        n.onclick = () => {
          window.focus();
          openView("calendar");
        };
      }
    } catch {
      /* some mobile browsers only allow notifications from a service worker */
    }
  }
}

export function startReminders(): () => void {
  const t = setInterval(check, 30_000);
  const first = setTimeout(check, 3_000);
  return () => {
    clearInterval(t);
    clearTimeout(first);
  };
}
