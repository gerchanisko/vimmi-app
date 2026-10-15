// Saving calendar events from the UI (events are notes in the calendar folder).
import { useEffect, useMemo, useState } from "react";
import {
  eventBody,
  eventFilePath,
  eventMarkdown,
  isCalendarFile,
  readExternalCalendar,
  type CalendarEvent,
  type EventInput,
  type ExternalCalendar,
} from "../../shared/calendar";
import { errorText, getState, refreshSnapshot, toast, useApp } from "./store";

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

// ---------- read-only calendars (.ics files in the vault) ----------

const icsCache = new Map<string, ExternalCalendar>();
const icsLoading = new Set<string>();
const icsListeners = new Set<() => void>();
let icsWatching = false;

function notifyIcs(): void {
  for (const l of icsListeners) l();
}

async function loadIcs(file: string): Promise<void> {
  if (icsLoading.has(file)) return;
  icsLoading.add(file);
  try {
    icsCache.set(file, readExternalCalendar(file, await window.vimmi.calendar.read(file)));
  } catch {
    icsCache.delete(file);
  } finally {
    icsLoading.delete(file);
    notifyIcs();
  }
}

/** Calendars from .ics files in the vault (subscriptions downloaded on the desktop, imported files). */
export function useExternalCalendars(): ExternalCalendar[] {
  const files = useApp((s) => s.snapshot?.files ?? EMPTY).filter(isCalendarFile);
  const key = files.join("\n");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    icsListeners.add(l);
    if (!icsWatching) {
      icsWatching = true;
      window.vimmi.vault.onNoteChanged(({ path }) => {
        if (isCalendarFile(path)) void loadIcs(path);
      });
    }
    return () => void icsListeners.delete(l);
  }, []);
  useEffect(() => {
    for (const f of files) if (!icsCache.has(f)) void loadIcs(f);
    for (const f of [...icsCache.keys()]) if (!files.includes(f)) icsCache.delete(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => files.map((f) => icsCache.get(f)).filter((c): c is ExternalCalendar => Boolean(c)), [key, tick]);
}

const EMPTY: string[] = [];
