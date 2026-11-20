import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { chatTranscript } from "@/lib/brain/chat";
import { ChatPanel } from "@/components/ChatPanel";
import { clearChatMessages } from "./actions";

export const dynamic = "force-dynamic";

type Topic = { id: string; name: string; open: number; pending: number; done: boolean };

/** Every project, with what is still open in it: requirements not done and proposals waiting. */
async function topics(): Promise<Topic[]> {
  const [projects, reqs, pending] = await Promise.all([
    db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).orderBy(desc(schema.projects.updatedAt)),
    db.select({ projectId: schema.requirements.projectId, status: schema.requirements.status }).from(schema.requirements),
    db.select({ projectId: schema.proposals.projectId }).from(schema.proposals).where(eq(schema.proposals.status, "pending")),
  ]);
  return projects.map((p) => {
    const mine = reqs.filter((r) => r.projectId === p.id);
    const open = mine.filter((r) => r.status !== "done" && r.status !== "dropped").length;
    const waiting = pending.filter((x) => x.projectId === p.id).length;
    return { id: p.id, name: p.name, open, pending: waiting, done: mine.length > 0 && open === 0 && waiting === 0 };
  });
}

const PROJECT_EXAMPLES = [
  "What is still open here, and what is blocking it?",
  "What changed in Jira on these tickets?",
  "What should I ask the stakeholders next?",
];

export default async function ChatPage({ searchParams }: PageProps<"/chat">) {
  const { ask, project } = await searchParams;
  const all = await topics();
  const current = typeof project === "string" ? (all.find((t) => t.id === project) ?? null) : null;
  const messages = await chatTranscript(current?.id ?? null);
  const open = all.filter((t) => !t.done);
  const finished = all.filter((t) => t.done);

  const item = (href: string, label: string, active: boolean, detail?: string) => (
    <Link
      href={href}
      className={`block shrink-0 rounded-lg px-3 py-2 text-sm ${active ? "bg-surface font-medium text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
    >
      <span className="block truncate">{label}</span>
      {detail ? <span className="block text-xs text-muted">{detail}</span> : null}
    </Link>
  );
  const detailOf = (t: Topic) =>
    [t.open ? `${t.open} open` : null, t.pending ? `${t.pending} in inbox` : null].filter(Boolean).join(" · ") || "Nothing open";

  return (
    <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="md:border-r md:border-line md:pr-4">
        <div className="flex gap-1 overflow-x-auto md:block md:space-y-1">
          {item("/chat", "General", !current)}
          <p className="hidden px-3 pt-4 text-xs font-medium uppercase tracking-wide text-muted md:block">Open projects</p>
          {open.map((t) => item(`/chat?project=${t.id}`, t.name, current?.id === t.id, detailOf(t)))}
          {open.length === 0 ? <p className="hidden px-3 text-sm text-muted md:block">Nothing in progress.</p> : null}
          {finished.length ? (
            <>
              <p className="hidden px-3 pt-4 text-xs font-medium uppercase tracking-wide text-muted md:block">Done</p>
              {finished.map((t) => item(`/chat?project=${t.id}`, t.name, current?.id === t.id))}
            </>
          ) : null}
        </div>
      </aside>

      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{current ? current.name : "Ask ISA"}</h1>
          {messages.length ? (
            <form action={clearChatMessages}>
              {current ? <input type="hidden" name="projectId" value={current.id} /> : null}
              <button className="text-sm text-muted hover:text-ink">New chat</button>
            </form>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted">
          {current ? (
            <>
              ISA answers about this project, using its meetings, emails, Slack and Jira tickets.{" "}
              <Link href={`/projects/${current.id}`} className="underline">
                Open the project
              </Link>
            </>
          ) : (
            "Ask anything. ISA knows your projects, meetings, emails, Slack and Jira, and can correct drafts or set rules. Changes wait in the inbox for your approval."
          )}
        </p>
        <ChatPanel
          key={current?.id ?? "general"}
          messages={messages}
          projectId={current?.id ?? null}
          examples={current ? PROJECT_EXAMPLES : undefined}
          initial={typeof ask === "string" ? ask : ""}
        />
      </div>
    </div>
  );
}
