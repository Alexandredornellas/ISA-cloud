"use client";

import { useEffect, useId, useState } from "react";

/** Renders Mermaid source as an SVG (strict mode: no scripts or links), with the source on failure. */
export function MermaidView({ source, title }: { source: string; title: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
        const out = await mermaid.render(`m${id}`, source);
        if (live) setSvg(out.svg);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [id, source]);

  if (failed) {
    return (
      <div className="rounded-lg border border-line bg-bg p-3 text-xs">
        <p className="mb-2 text-muted">This diagram did not render. Here is its source; you can redraw it.</p>
        <pre className="overflow-x-auto whitespace-pre-wrap">{source}</pre>
      </div>
    );
  }
  if (!svg) return <div className="h-40 animate-pulse rounded-lg bg-bg" aria-label={`Drawing ${title}`} />;
  return <div role="img" aria-label={title} className="mermaid-view overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-h-[560px] [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
