// How each kind of source is named and marked across the app.
export const SOURCES: Record<string, { label: string; mark: string; bg: string }> = {
  zoom: { label: "Zoom", mark: "Z", bg: "#2D6CDF" },
  meet: { label: "Google Meet", mark: "M", bg: "#00695C" },
  teams: { label: "Teams", mark: "T", bg: "#4B53BC" },
  gmail: { label: "Email", mark: "@", bg: "#B3261E" },
  slack: { label: "Slack", mark: "S", bg: "#4A154B" },
  manual: { label: "Note", mark: "N", bg: "#5F6368" },
  jira: { label: "Jira", mark: "J", bg: "#2F5BD3" },
};

export const sourceOf = (s: string) => SOURCES[s] ?? SOURCES.manual;

/** "5m ago", "3h ago", "Yesterday", or a date: short, for busy readers. */
export function timeAgo(d: Date, now = new Date()): string {
  const s = Math.max(0, (now.getTime() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const fullTime = (d: Date) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
