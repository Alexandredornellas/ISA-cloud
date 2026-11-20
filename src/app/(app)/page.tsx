import Link from "next/link";
import { chatTranscript } from "@/lib/brain/chat";
import { channels, decisions, notifications } from "@/lib/channels";
import { ChannelView } from "@/components/ChannelView";
import { clearChatMessages } from "./chat/actions";

export const dynamic = "force-dynamic";

const PROJECT_EXAMPLES = [
  "What is still open here, and what is blocking it?",
  "What changed in Jira on these tickets?",
  "What should I ask the stakeholders next?",
];

/** ISA's home: channels on the left (General plus one per project), the selected channel on the right. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const { c, ask } = await searchParams;
  const all = await channels();
  const projects = all.filter((ch) => ch.id);
  const current = (typeof c === "string" && projects.find((ch) => ch.id === c)) || all[0];
  const projectId = current.id;
  const [notes, chat, log] = await Promise.all([notifications(projectId), chatTranscript(projectId), decisions(projectId)]);
  const messages = [
    ...chat.map((m) => ({ id: m.id, role: m.role, text: m.text, used: m.used, at: m.at })),
    ...log.map((l) => ({ id: `log-${l.id}`, role: "log" as const, text: `${l.at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${l.text}`, at: l.at })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((m) => ({ id: m.id, role: m.role, text: m.text, used: "used" in m ? m.used : undefined }));

  const open = projects.filter((p) => !p.done);
  const done = projects.filter((p) => p.done);
  const item = (ch: (typeof all)[number]) => {
    const active = ch.id === current.id;
    return (
      <Link
        key={ch.id ?? "general"}
        href={ch.id ? `/?c=${ch.id}` : "/"}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-12 shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-accent-soft text-ink" : "text-ink hover:bg-bg"}`}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{ch.name}</span>
          <span className={`block text-xs ${ch.count ? "text-warn" : "text-muted"}`}>
            {ch.count ? `${ch.count} need${ch.count === 1 ? "s" : ""} you` : ch.id ? "Up to date" : "All projects"}
          </span>
        </span>
        {ch.count ? (
          <span className="inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-warn px-1.5 text-xs font-semibold text-surface">
            {ch.count}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <div className="grid gap-6 md:grid-cols-[240px_minmax(0,1fr)]">
      <aside aria-label="Channels" className="min-w-0 md:border-r md:border-line md:pr-4">
        <div className="flex gap-1 overflow-x-auto md:block md:space-y-1">
          {item(all[0])}
          <p className="hidden px-3 pt-4 text-xs font-semibold uppercase tracking-wide text-muted md:block">Projects</p>
          {open.map(item)}
          {open.length === 0 ? <p className="hidden px-3 text-sm text-muted md:block">No projects yet.</p> : null}
          {done.length ? (
            <>
              <p className="hidden px-3 pt-4 text-xs font-semibold uppercase tracking-wide text-muted md:block">Done</p>
              {done.map(item)}
            </>
          ) : null}
        </div>
      </aside>

      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{current.name}</h1>
            <p className="mt-1 text-sm text-muted">
              {projectId
                ? "Everything about this project: what needs you, and a chat with ISA that knows its meetings, emails, Slack and Jira."
                : "Ask ISA anything. Items she can't place in a project wait here for you."}
            </p>
          </div>
          <div className="flex gap-2">
            {projectId ? (
              <Link href={`/projects/${projectId}`} className="rounded-lg border border-line px-3 py-2 text-sm font-medium">
                Requirements and tickets
              </Link>
            ) : null}
            {chat.length ? (
              <form action={clearChatMessages}>
                {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
                <button className="rounded-lg px-3 py-2 text-sm text-muted hover:text-ink">New chat</button>
              </form>
            ) : null}
          </div>
        </div>
        <div className="mt-5">
          <ChannelView
            key={projectId ?? "general"}
            projectId={projectId}
            name={current.name}
            notifications={notes}
            messages={messages}
            examples={projectId ? PROJECT_EXAMPLES : undefined}
            initial={typeof ask === "string" ? ask : ""}
          />
        </div>
      </div>
    </div>
  );
}
