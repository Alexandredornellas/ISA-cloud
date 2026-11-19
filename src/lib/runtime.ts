import { claudeStructured } from "@/lib/brain/llm";
import { RecallClient, recallConfigFromEnv } from "@/lib/recall";
import { SlackClient, slackConfigFromEnv } from "@/lib/slack";
import { tick, type WorkerDeps } from "@/lib/worker";

function optional<T>(make: () => T): T | null {
  try {
    return make();
  } catch {
    return null;
  }
}

// One Slack client per process, so its user-name cache survives between passes.
let slack: SlackClient | null | undefined;
export function liveSlack(): SlackClient | null {
  if (slack === undefined) slack = optional(() => new SlackClient(slackConfigFromEnv()));
  return slack;
}

export function liveWorkerDeps(): WorkerDeps {
  return {
    recall: optional(() => new RecallClient(recallConfigFromEnv())),
    slack: liveSlack(),
    llm: process.env.ANTHROPIC_API_KEY ? claudeStructured : null,
  };
}

const INTERVAL_MS = 10_000;
const SLACK_EVERY = 3; // passes, so Slack is read every 30 seconds

/** Run the worker every 10 seconds inside the web server process. One loop per process. */
export function startWorker() {
  const g = globalThis as unknown as { isaWorker?: boolean };
  if (g.isaWorker || process.env.ISA_WORKER === "off") return;
  g.isaWorker = true;
  let running = false;
  let pass = 0;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick({ ...liveWorkerDeps(), readSlack: pass++ % SLACK_EVERY === 0 });
    } catch (err) {
      console.error("worker tick failed", { error: err instanceof Error ? err.name : "unknown" });
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  console.log("ISA worker started");
}
