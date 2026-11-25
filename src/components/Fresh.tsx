"use client";

import { useEffect } from "react";
import { isNew, stampVisit, useSince } from "@/lib/seen";

/** Wraps a row and marks it `data-new` when it arrived since the owner's last visit. */
export function Fresh({ at, className = "", children }: { at: Date | string; className?: string; children: React.ReactNode }) {
  const fresh = isNew(at, useSince());
  return (
    <div data-new={fresh ? "true" : undefined} className={`group/fresh ${className}`}>
      {children}
    </div>
  );
}

/** The blue dot of a new row. Sits inside a `Fresh` wrapper and takes its space either way, so rows stay aligned. */
export function NewDot() {
  return (
    <span className="relative inline-flex h-2 w-2 flex-none">
      <span className="h-2 w-2 rounded-full bg-accent opacity-0 group-data-[new=true]/fresh:opacity-100" />
      <span className="sr-only hidden group-data-[new=true]/fresh:inline">New</span>
    </span>
  );
}

/** Keeps "when was the owner last here" current while the app is open. Renders nothing. */
export function VisitStamp() {
  useEffect(() => {
    stampVisit();
    const timer = setInterval(stampVisit, 30_000);
    return () => clearInterval(timer);
  }, []);
  return null;
}
