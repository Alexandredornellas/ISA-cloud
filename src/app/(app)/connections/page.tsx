import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { JiraClient, jiraConfigFromEnv } from "@/lib/jira";
import { liveSlack } from "@/lib/runtime";
import { SendBotForm } from "@/components/SendBotForm";

export const dynamic = "force-dynamic";

type Status = { name: string; ok: boolean; detail: string };

async function jiraStatus(): Promise<Status> {
  try {
    const project = await new JiraClient(jiraConfigFromEnv()).checkProject();
    return { name: "Jira", ok: true, detail: `Project ${project.key}: ${project.name}` };
  } catch (err) {
    return { name: "Jira", ok: false, detail: err instanceof Error ? err.message : "Not connected" };
  }
}

async function slackStatus(): Promise<Status> {
  const slack = liveSlack();
  if (!slack) return { name: "Slack", ok: false, detail: "Set SLACK_USER_TOKEN and SLACK_BOT_TOKEN" };
  try {
    const me = await slack.whoAmI();
    return { name: "Slack", ok: true, detail: `${me.team}, reading as ${me.user}, posting as ISA` };
  } catch (err) {
    return { name: "Slack", ok: false, detail: err instanceof Error ? err.message : "Not connected" };
  }
}

function envStatus(name: string, vars: string[], okDetail: string, missingDetail: string): Status {
  const ok = vars.every((v) => !!process.env[v]);
  return { name, ok, detail: ok ? okDetail : missingDetail };
}

const BOT_LABEL = {
  scheduled: "Scheduled",
  in_call: "In the call",
  processing: "Getting transcript",
  done: "Transcript in inbox",
  failed: "Failed",
} as const;

export default async function ConnectionsPage() {
  const statuses: Status[] = [
    envStatus("Claude", ["ANTHROPIC_API_KEY"], "API key set", "Set ANTHROPIC_API_KEY"),
    await jiraStatus(),
    envStatus("Meeting bot", ["RECALL_API_KEY"], "Recall.ai key set", "Set RECALL_API_KEY"),
    { name: "Gmail", ok: false, detail: "Coming soon" },
    await slackStatus(),
  ];
  const bots = await db.select().from(schema.meetingBots).orderBy(desc(schema.meetingBots.createdAt)).limit(10);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-surface">
          {statuses.map((s) => (
            <li key={s.name} className="flex items-start justify-between gap-4 p-4">
              <div>
                <p className="font-medium">{s.name}</p>
                <p className="mt-0.5 break-all text-sm text-muted">{s.detail}</p>
              </div>
              <span className={`shrink-0 text-sm font-medium ${s.ok ? "text-ok" : "text-muted"}`}>
                {s.ok ? "Connected" : "Off"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Meetings</h2>
        <SendBotForm />
        {bots.length ? (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {bots.map((b) => (
              <li key={b.id} className="flex items-start justify-between gap-4 p-4 text-sm">
                <div>
                  <p className="font-medium">{b.title}</p>
                  <p className="mt-0.5 text-muted">
                    {(b.joinAt ?? b.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                    {b.error ? ` · ${b.error}` : ""}
                  </p>
                </div>
                <span className={`shrink-0 font-medium ${b.status === "failed" ? "text-danger" : b.status === "done" ? "text-ok" : "text-muted"}`}>
                  {BOT_LABEL[b.status]}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
