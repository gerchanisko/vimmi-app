// Saving calendar events from the UI (events are notes in the calendar folder).
import { eventBody, eventFilePath, eventMarkdown, type CalendarEvent, type EventInput } from "../../shared/calendar";
import { errorText, getState, refreshSnapshot, toast } from "./store";

export function calendarFolder(): string {
  return getState().settings?.calendarFolder || "Kalendář";
}

/** Creates a new event, or rewrites an existing one (keeping its description unless given). */
export async function saveEvent(input: EventInput, existing?: CalendarEvent): Promise<string | null> {
  try {
    let path: string;
    if (existing) {
      const body = input.description !== undefined ? `\n${input.description.trim()}\n` : eventBody(await window.vimmi.vault.read(existing.path));
      await window.vimmi.vault.write(existing.path, eventMarkdown(input, body));
      path = existing.path;
    } else {
      path = await window.vimmi.vault.create(eventFilePath(calendarFolder(), input), eventMarkdown(input));
    }
    await refreshSnapshot();
    if (input.remind !== undefined && !input.allDay) void askNotificationPermission();
    return path;
  } catch (err) {
    toast(errorText(err), "error");
    return null;
  }
}

export async function deleteEvent(event: CalendarEvent): Promise<void> {
  try {
    await window.vimmi.vault.trash(event.path);
    await refreshSnapshot();
    toast(`Událost „${event.title}“ je smazaná.`);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** Input that reproduces an existing event (for moving/resizing). */
export function eventToInput(e: CalendarEvent): EventInput {
  return {
    title: e.title,
    date: e.date,
    endDate: e.endDate,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    repeat: e.repeat,
    until: e.until,
    remind: e.remind,
    color: e.color,
  };
}

export async function askNotificationPermission(): Promise<void> {
  try {
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  } catch {
    /* not supported (e.g. some mobile browsers) */
  }
}
