import type { Instrumentation } from "next";

// Called once when the server starts. Runs ISA's background worker in the Node runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { log } = await import("./lib/log");
    const g = globalThis as unknown as { isaProcessHooks?: boolean };
    if (!g.isaProcessHooks) {
      g.isaProcessHooks = true;
      // Errors nobody awaited would otherwise vanish or only print a bare stack.
      process.on("unhandledRejection", (reason) => log.error("unhandled promise rejection", reason));
      process.on("uncaughtException", (err) => log.error("uncaught exception", err));
    }
    const { logConfiguration, startWorker } = await import("./lib/runtime");
    logConfiguration();
    startWorker();
  }
}

/** Every server error Next.js catches (pages, server actions, API routes), with the route it came from. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { log } = await import("./lib/log");
  log.error("request failed", err, {
    method: request.method,
    // The path without its query string, which can hold search text.
    path: request.path.split("?")[0],
    route: context.routePath,
    routeType: context.routeType,
    renderSource: "renderSource" in context ? context.renderSource : undefined,
  });
};
