import { directory, pendingSuggestions } from "@/lib/people";
import { AddPersonForm, PersonCard, SuggestionList } from "@/components/People";

export const dynamic = "force-dynamic";

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const [people, suggestions] = await Promise.all([directory(q), pendingSuggestions()]);
  return (
    <div className="mx-auto max-w-3xl px-4 py-7 sm:px-8">
      <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">People</h1>
      <p className="mt-1 text-sm text-muted">
        Who does what across the company, what they can help with, and who moves each project forward. You keep this list. ISA suggests what she hears in meetings, email and Slack, and saves it only when you say so.
      </p>

      {suggestions.length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">ISA noticed · {suggestions.length}</h2>
          <SuggestionList suggestions={suggestions} />
        </section>
      ) : null}

      <section className="mt-7">
        <form className="mb-3 flex gap-2" role="search">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Who can help with… e.g. PCI, budget, Android"
            aria-label="Search people"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          />
          <button className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-hover">Search</button>
        </form>
        <AddPersonForm />
        {people.length ? (
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {people.map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-muted">{q ? `Nobody matches “${q}”.` : "Nobody yet. Add the people you work with, or let ISA suggest them as she listens."}</p>
        )}
      </section>
    </div>
  );
}
