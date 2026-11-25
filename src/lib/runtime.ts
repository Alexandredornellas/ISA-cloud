import { claudeStructured } from "@/lib/brain/llm";
import { RecallClient, recallConfigFromEnv } from "@/lib/recall";
import { SlackClient, slackConfigFromEnv } from "@/lib/slack";
import { liveGoogle } from "@/lib/google";
import { JiraClient, jiraConfigFromEnv } from "@/lib/jira";
import { tick, type WorkerDeps } from "@/lib/worker";
import { log } from "@/lib/log";

function optional<T>(make: () => T): T | null {
  try {
    return make();
  } catch {
    // Not configured: logged once at startup by logConfiguration.
    return null;
  }
}

/** Which integrations are set up, as yes/no only, so a missing variable shows in the first log lines. */
export function logConfiguration() {
  const has = (...names: string[]) => names.every((n) => !!process.env[n]);
  log.info("ISA configuration", {
    database: has("DATABASE_URL"),
    password: has("ISA_PASSWORD"),
    claude: has("ANTHROPIC_API_KEY"),
    recall: has("RECALL_API_KEY"),
    slack: has("SLACK_USER_TOKEN", "SLACK_BOT_TOKEN"),
    google: has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APP_URL"),
    jira: has("JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY"),
    worker: process.env.ISA_WORKER !== "off",
    logLevel: process.env.LOG_LEVEL ?? "info",
  });
  if (!has("DATABASE_URL")) log.warn("DATABASE_URL is not set: every page and the worker will fail");
  if (!has("ISA_PASSWORD")) log.warn("ISA_PASSWORD is not set: every page answers 500");
  if (!has("ANTHROPIC_API_KEY")) log.warn("ANTHROPIC_API_KEY is not set: new items will not be sorted and the chat will fail");
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
    google: liveGoogle(),
    jira: optional(() => new JiraClient(jiraConfigFromEnv())),
    llm: process.env.ANTHROPIC_API_KEY ? claudeStructured : null,
  };
}

const INTERVAL_MS = 10_000;

/** Run the worker every 10 seconds inside the web server process. One loop per process. */
export function startWorker() {
  const g = globalThis as unknown as { isaWorker?: boolean };
  if (g.isaWorker || process.env.ISA_WORKER === "off") return;
  g.isaWorker = true;
  let running = false;
  let pass = 0;
  let skipped = 0;
  let failuresInARow = 0;
  setInterval(async () => {
    if (running) {
      // A pass still running after 10 s: worth seeing if it keeps happening (a hung call).
      skipped += 1;
      if (skipped % 6 === 0) log.warn("worker pass still running", { pass, skippedTicks: skipped });
      return;
    }
    running = true;
    skipped = 0;
    try {
      await tick({ ...liveWorkerDeps(), pass: pass++ });
      if (failuresInARow) log.info("worker recovered", { pass, failuresInARow });
      failuresInARow = 0;
    } catch (err) {
      failuresInARow += 1;
      log.error("worker tick failed", err, { pass, failuresInARow });
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  log.info("ISA worker started", { intervalMs: INTERVAL_MS });
}
