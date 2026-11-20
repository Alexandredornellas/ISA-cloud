import { sourceOf } from "@/lib/sources";

/** The small colored square that tells where something came from. */
export function SourceMark({ source, size = "md", failed = false }: { source: string; size?: "sm" | "md"; failed?: boolean }) {
  const s = sourceOf(source);
  const box = size === "sm" ? "h-6 w-6 text-[11px] rounded-md" : "h-8 w-8 text-sm rounded-lg";
  return (
    <span
      aria-hidden="true"
      title={s.label}
      className={`inline-flex flex-none items-center justify-center font-bold text-white ${box}`}
      style={{ background: failed ? "#B3261E" : s.bg }}
    >
      {failed ? "!" : s.mark}
    </span>
  );
}
