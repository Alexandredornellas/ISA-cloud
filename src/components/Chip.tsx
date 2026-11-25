import type { Tone } from "@/lib/briefing";
import type { DiffPart } from "@/lib/diff";

const TONE: Record<Tone, string> = {
  danger: "bg-danger/15 text-danger",
  warn: "bg-warn/15 text-warn",
  accent: "bg-accent-soft text-accent",
  neutral: "bg-hover text-muted",
};

/** The word that says what kind of row this is. Colour repeats the word, never replaces it. */
export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`flex-none rounded px-1.5 py-0.5 text-center text-[11px] font-semibold sm:w-[4.5rem] ${TONE[tone]}`}>{children}</span>;
}

/** Before → after on one line: what went away struck through in red, what came in green. */
export function BeforeAfter({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "removed" ? (
          <del key={i} className="text-danger decoration-1">
            {p.text.trim()}
          </del>
        ) : (
          <span key={i}>
            {parts[i - 1]?.kind === "removed" ? (
              <span className="px-1 text-muted" aria-label="changed to">
                →
              </span>
            ) : parts.length === 1 ? (
              <span className="pr-1 text-ok" aria-label="added">
                +
              </span>
            ) : null}
            <ins className="font-medium text-ok no-underline">{p.text.trim()}</ins>
            {/\s$/.test(p.text) ? " " : ""}
          </span>
        ),
      )}
    </>
  );
}
