"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const EVERY_MS = 3_000;

/** True while the owner is typing into a field that already holds text, so a refresh waits. */
function typing(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "submit", "button"].includes(el.type))) {
    return el.value.trim().length > 0;
  }
  return el instanceof HTMLSelectElement;
}

/**
 * Keeps every screen current without a manual reload: asks the server every few seconds whether
 * anything changed and, if so, refreshes the page data in place. Client state (open panels, the
 * chat box, scroll) is kept. Paused while the tab is hidden.
 */
export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    let waiting = false; // a change arrived while the owner was typing
    let busy = false;
    let stopped = false;

    async function check() {
      if (busy || stopped || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const r = await fetch("/api/live", { cache: "no-store", redirect: "manual" });
        if (!r.ok) return;
        const { stamp } = (await r.json()) as { stamp: string | null };
        if (!stamp) return;
        if (last !== null && stamp !== last) waiting = true;
        last = stamp;
        if (waiting && !typing()) {
          waiting = false;
          router.refresh();
        }
      } catch {
        // Offline or redeploying: try again on the next tick.
      } finally {
        busy = false;
      }
    }

    void check();
    const timer = setInterval(check, EVERY_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);
  return null;
}
