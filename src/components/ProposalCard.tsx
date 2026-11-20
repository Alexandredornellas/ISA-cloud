import Link from "next/link";
import { describeAction, type Plan } from "@/lib/plan";
import { SubmitButton } from "@/components/SubmitButton";
import { approveProposal, dismissProposal } from "@/app/(app)/actions";

type Props = {
  id: string;
  kind: "new_project" | "update" | "clarify";
  status: string;
  title: string;
  plan: Plan;
  projectId: string | null;
  projectName: string | null;
  sources: { id: string; source: string; title: string; url: string | null }[];
  error: string | null;
  createdAt: Date;
};

const KIND_LABEL = {
  new_project: "New project",
  update: "Changes",
  clarify: "Question",
} as const;

const SOURCE_LABEL: Record<string, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Teams",
  gmail: "Email",
  slack: "Slack",
  manual: "Note",
  jira: "Jira",
};

export function ProposalCard(p: Props) {
  const pending = p.status === "pending";
  return (
    <article className="rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            p.kind === "new_project" ? "bg-accent-soft text-accent" : "bg-bg text-ink"
          }`}
        >
          {KIND_LABEL[p.kind]}
        </span>
        {p.projectId && p.projectName ? (
          <Link href={`/projects/${p.projectId}`} className="hover:text-ink">
            {p.projectName}
          </Link>
        ) : null}
        <span>· {p.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>

      <h2 className="mt-2 text-lg font-semibold">{p.title}</h2>
      <p className="mt-1 text-sm">{p.plan.summary}</p>

      {p.sources.length ? (
        <p className="mt-2 text-xs text-muted">
          From{" "}
          {p.sources.map((s, i) => (
            <span key={s.id}>
              {i > 0 ? ", " : ""}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                  {SOURCE_LABEL[s.source] ?? s.source}: {s.title}
                </a>
              ) : (
                `${SOURCE_LABEL[s.source] ?? s.source}: ${s.title}`
              )}
            </span>
          ))}
        </p>
      ) : null}

      {p.plan.requirementChanges.length ? (
        <section className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Requirements</h3>
          <ul className="mt-2 space-y-2">
            {p.plan.requirementChanges.map((r) => (
              <li key={r.ref} className="text-sm">
                <span className="mr-2 rounded bg-bg px-1.5 py-0.5 text-xs text-muted">
                  {r.op === "create" ? "new" : r.op === "drop" ? "drop" : "change"}
                </span>
                <span className="font-medium">{r.title}</span>
                {r.description ? <p className="mt-0.5 text-muted">{r.description}</p> : null}
                {r.approvedBy ? <p className="mt-0.5 text-xs text-ok">Approved by {r.approvedBy}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.plan.actions.length ? (
        <section className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">ISA will</h3>
          <ul className="mt-2 space-y-2">
            {p.plan.actions.map((a, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{describeAction(a)}</span>
                {a.type === "slack_message" ? <Quote text={a.text} /> : null}
                {a.type === "email" ? <Quote text={`${a.subject}\n\n${a.body}`} /> : null}
                {a.type === "jira_comment" ? <Quote text={a.body} /> : null}
                {a.type === "jira_create" ? <Quote text={a.description} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.plan.openQuestions.length ? (
        <section className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Open questions</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {p.plan.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.error ? (
        <p className="mt-4 whitespace-pre-wrap rounded-lg bg-bg p-3 text-sm text-danger">{p.error}</p>
      ) : null}

      {pending ? (
        <div className="mt-5 flex gap-2">
          <form action={approveProposal}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton className="bg-accent text-white">{p.kind === "clarify" ? "Yes" : "Approve"}</SubmitButton>
          </form>
          <form action={dismissProposal}>
            <input type="hidden" name="id" value={p.id} />
            <SubmitButton className="border border-line">{p.kind === "clarify" ? "No" : "Dismiss"}</SubmitButton>
          </form>
        </div>
      ) : null}
    </article>
  );
}

function Quote({ text }: { text: string }) {
  return (
    <p className="mt-1 whitespace-pre-wrap border-l-2 border-line pl-3 text-muted">{text}</p>
  );
}
