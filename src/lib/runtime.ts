import { claudeStructured } from "@/lib/brain/llm";
import { RecallClient, recallConfigFromEnv } from "@/lib/recall";
import { tick, type WorkerDeps } from "@/lib/worker";

export function liveWorkerDeps(): WorkerDeps {
  let recall: RecallClient | null = null;
  try {
    recall = new RecallClient(recallConfigFromEnv());
  } catch {
    recall = null;
  }
  return { recall, llm: process.env.ANTHROPIC_API_KEY ? claudeStructured : null };
}

const INTERVAL_MS = 10_000;

/** Run the worker every 10 seconds inside the web server process. One loop per process. */
export function startWorker() {
  const g = globalThis as unknown as { isaWorker?: boolean };
  if (g.isaWorker || process.env.ISA_WORKER === "off") return;
  g.isaWorker = true;
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(liveWorkerDeps());
    } catch (err) {
      console.error("worker tick failed", { error: err instanceof Error ? err.name : "unknown" });
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  console.log("ISA worker started");
}
