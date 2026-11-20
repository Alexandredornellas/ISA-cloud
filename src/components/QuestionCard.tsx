import { answerTicketTypeQuestion } from "@/app/(app)/actions";
import type { MissingTypeQuestion } from "@/lib/queries";

/** ISA could not create some tickets because Jira lacks their type, and asks what to do. */
export function QuestionCard({ q }: { q: MissingTypeQuestion }) {
  const n = q.tickets.length;
  return (
    <article className="rounded-xl border border-warn bg-surface p-5">
      <div className="text-xs text-muted">
        <span className="rounded-full bg-bg px-2 py-0.5 font-medium text-warn">Question</span> · {q.proposalTitle}
      </div>
      <h2 className="mt-2 text-lg font-semibold">
        Your Jira project {q.projectKey} has no &quot;{q.wanted}&quot; type. What should ISA use instead?
      </h2>
      <p className="mt-1 text-sm text-muted">
        {n === 1 ? "1 ticket is" : `${n} tickets are`} waiting: {q.tickets.join(", ")}.
      </p>
      <form action={answerTicketTypeQuestion} className="mt-4 space-y-3">
        <input type="hidden" name="proposalId" value={q.proposalId} />
        <input type="hidden" name="wanted" value={q.wanted} />
        <div className="flex flex-wrap gap-2">
          {q.available.map((t) => (
            <button key={t} name="choice" value={t} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">
              Create as {t}
            </button>
          ))}
          <button name="choice" value="__skip" className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
            Skip {n === 1 ? "this ticket" : "these tickets"}
          </button>
        </div>
        {q.kindNames.length ? (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" name="remember" defaultChecked />
            Always use this type for {q.kindNames.join(" and ")} (you can change it under Ticket formats)
          </label>
        ) : null}
      </form>
    </article>
  );
}
