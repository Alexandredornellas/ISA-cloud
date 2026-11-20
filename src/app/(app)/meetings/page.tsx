import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { GoogleClient } from "@/lib/google";
import { SendBotForm } from "@/components/SendBotForm";
import { setAutoJoin } from "../connections/actions";

export const dynamic = "force-dynamic";

const BOT_LABEL = {
  scheduled: { text: "Scheduled", style: "bg-accent-soft text-accent" },
  in_call: { text: "In the call", style: "bg-ok/15 text-ok" },
  processing: { text: "Getting transcript", style: "bg-warn/15 text-warn" },
  done: { text: "Transcript in", style: "bg-bg text-muted" },
  failed: { text: "Failed", style: "bg-danger/15 text-danger" },
} as const;

const when = (d: Date) => d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: process.env.ISA_TIMEZONE || "America/Fortaleza" });

/** Meetings: send ISA Notetaker to a call, let it join calendar meetings, and see where it has been. */
export default async function MeetingsPage() {
  const [google, bots] = await Promise.all([
    GoogleClient.connection(),
    db.select().from(schema.meetingBots).orderBy(desc(schema.meetingBots.createdAt)).limit(30),
  ]);
  const autoJoin = google?.state.autoJoin === "on";
  const upcoming = bots.filter((b) => b.status === "scheduled" || b.status === "in_call").sort((a, b) => (a.joinAt?.getTime() ?? 0) - (b.joinAt?.getTime() ?? 0));
  const past = bots.filter((b) => !upcoming.includes(b));

  const list = (rows: typeof bots) => (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {rows.map((b) => {
        const label = BOT_LABEL[b.status];
        return (
          <li key={b.id} className="flex items-start justify-between gap-4 p-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{b.title}</p>
              <p className="mt-0.5 text-xs text-muted">
                {when(b.joinAt ?? b.createdAt)} · {b.platform}
                {b.error ? ` · ${b.error}` : ""}
              </p>
            </div>
            <span className={`flex-none rounded px-1.5 py-0.5 text-xs font-medium ${label.style}`}>{label.text}</span>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-7 sm:px-8">
      <section>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Meetings</h1>
        <p className="mt-1 text-sm text-muted">
          ISA Notetaker joins the call under its own visible name, records it, and turns what was said into suggestions, answers and reminders for you.
        </p>
        <div className="mt-5">
          <SendBotForm />
        </div>
      </section>

      <section>
        {google ? (
          <form action={setAutoJoin} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
            <p className="text-sm">
              <span className="font-medium">Join my calendar meetings by itself</span>
              <span className="block text-muted">Every meeting in {google.account}&apos;s calendar with a Zoom, Meet or Teams link that you haven&apos;t declined.</span>
            </p>
            <input type="hidden" name="on" value={autoJoin ? "off" : "on"} />
            <button
              role="switch"
              aria-checked={autoJoin}
              aria-label="Join my calendar meetings by itself"
              className={`relative h-6 w-11 flex-none rounded-full transition-colors ${autoJoin ? "bg-accent" : "bg-line"}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${autoJoin ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </form>
        ) : (
          <a href="/connections" className="block rounded-xl border border-dashed border-line p-4 text-sm text-muted hover:text-ink">
            Connect Google in Connections to let ISA join your calendar meetings by itself →
          </a>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Coming up</h2>
        {upcoming.length ? list(upcoming) : <p className="text-sm text-muted">No meetings scheduled.</p>}
      </section>

      {past.length ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Recent</h2>
          {list(past)}
        </section>
      ) : null}
    </div>
  );
}
