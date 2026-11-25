"use client";

// "New since your last visit": remembered in the browser only, so it needs no account or table.
// A visit is one browser tab session. Its starting point is when the owner was last here.
import { useSyncExternalStore } from "react";

const LAST_VISIT = "isa:last-visit";
const SINCE = "isa:since";
const listeners = new Set<() => void>();

function read(): number | null {
  try {
    const kept = sessionStorage.getItem(SINCE);
    if (kept) return Number(kept);
    // A first visit ever has nothing to compare against, so nothing is marked new.
    const since = Number(localStorage.getItem(LAST_VISIT)) || Date.now();
    sessionStorage.setItem(SINCE, String(since));
    return since;
  } catch {
    return null; // Storage blocked: no markers, the page still works.
  }
}

/** Record that the owner is here now, for the next visit to compare against. */
export function stampVisit() {
  try {
    read();
    localStorage.setItem(LAST_VISIT, String(Date.now()));
  } catch {
    // Storage blocked.
  }
}

/** Treat everything up to now as seen. */
export function markAllSeen() {
  try {
    sessionStorage.setItem(SINCE, String(Date.now()));
    localStorage.setItem(LAST_VISIT, String(Date.now()));
  } catch {
    // Storage blocked.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** When this visit's "new" starts, in ms, or null on the server and where storage is blocked. */
export function useSince(): number | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** Whether something that happened at `at` is new to the owner on this visit. */
export const isNew = (at: Date | string, since: number | null) => since !== null && new Date(at).getTime() > since;
