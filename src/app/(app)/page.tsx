import { ProposalCard } from "@/components/ProposalCard";
import { inboxProposals } from "@/lib/queries";
import { SubmitButton } from "@/components/SubmitButton";
import { retryProposal } from "./actions";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const proposals = await inboxProposals();
  const pending = proposals.filter((p) => p.status === "pending");
  const recent = proposals.filter((p) => p.status !== "pending");

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="mt-1 text-sm text-muted">
          {pending.length === 0
            ? "Nothing waiting for you. ISA is listening."
            : `${pending.length} waiting for your approval`}
        </p>
        <div className="mt-5 space-y-4">
          {pending.map((p) => (
            <ProposalCard key={p.id} {...p} />
          ))}
        </div>
      </section>

      {recent.length ? (
        <section>
          <h2 className="text-sm font-medium text-muted">Done in the last day</h2>
          <ul className="mt-3 space-y-2">
            {recent.map((p) => (
              <li key={p.id} className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
                <span className={p.status === "failed" ? "text-danger" : "text-ok"}>
                  {p.status === "failed" ? "Failed" : "Done"}
                </span>{" "}
                · {p.title}
                {p.error ? <p className="mt-1 whitespace-pre-wrap text-xs text-danger">{p.error}</p> : null}
                {p.status === "failed" ? (
                  <form action={retryProposal} className="mt-2">
                    <input type="hidden" name="id" value={p.id} />
                    <SubmitButton className="border border-line">Try again</SubmitButton>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
