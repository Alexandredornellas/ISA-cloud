import { JiraClient, jiraConfigFromEnv } from "@/lib/jira";
import { liveSlack } from "@/lib/runtime";
import { GoogleClient, googleConfigFromEnv } from "@/lib/google";

export const dynamic = "force-dynamic";

type Status = { name: string; ok: boolean; detail: string };

async function jiraStatus(): Promise<Status> {
  try {
    const project = await new JiraClient(jiraConfigFromEnv()).checkProject();
    return {
      name: "Jira",
      ok: true,
      detail: `Project ${project.key}: ${project.name}`,
    };
  } catch (err) {
    return {
      name: "Jira",
      ok: false,
      detail: err instanceof Error ? err.message : "Not connected",
    };
  }
}

async function slackStatus(): Promise<Status> {
  const slack = liveSlack();
  if (!slack)
    return {
      name: "Slack",
      ok: false,
      detail: "Set SLACK_USER_TOKEN and SLACK_BOT_TOKEN",
    };
  try {
    const me = await slack.whoAmI();
    return {
      name: "Slack",
      ok: true,
      detail: `${me.team}, reading as ${me.user}, posting as ISA`,
    };
  } catch (err) {
    return {
      name: "Slack",
      ok: false,
      detail: err instanceof Error ? err.message : "Not connected",
    };
  }
}

function envStatus(
  name: string,
  vars: string[],
  okDetail: string,
  missingDetail: string,
): Status {
  const ok = vars.every((v) => !!process.env[v]);
  return { name, ok, detail: ok ? okDetail : missingDetail };
}

export default async function ConnectionsPage() {
  const statuses: Status[] = [
    envStatus(
      "Claude",
      ["ANTHROPIC_API_KEY"],
      "API key set",
      "Set ANTHROPIC_API_KEY",
    ),
    await jiraStatus(),
    envStatus(
      "Meeting bot",
      ["RECALL_API_KEY"],
      "Recall.ai key set",
      "Set RECALL_API_KEY",
    ),
    await slackStatus(),
  ];
  const googleConfigured = (() => {
    try {
      googleConfigFromEnv();
      return true;
    } catch {
      return false;
    }
  })();
  const google = await GoogleClient.connection();

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-7 sm:px-8">
      <section>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Connections
        </h1>
        <p className="mt-1 text-sm text-muted">
          Where ISA listens (meetings, email, Slack) and where she acts after
          you approve (Jira, Slack, email).
        </p>
        <ul className="mt-5 divide-y divide-line rounded-xl border border-line bg-surface">
          {statuses.map((s) => (
            <li
              key={s.name}
              className="flex items-start justify-between gap-4 p-4"
            >
              <div className="flex min-w-0 gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2.5 w-2.5 flex-none rounded-full ${s.ok ? "bg-ok" : "bg-line"}`}
                />
                <div className="min-w-0">
                  <p className="font-medium">{s.name}</p>
                  <p className="mt-0.5 break-all text-sm text-muted">
                    {s.detail}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 text-sm font-medium ${s.ok ? "text-ok" : "text-muted"}`}
              >
                {s.ok ? "Connected" : "Off"}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
          <div>
            <p className="font-medium">Gmail and Google Calendar</p>
            <p className="mt-0.5 text-sm text-muted">
              {google
                ? `${google.account}: ISA reads new inbox emails and sends approved replies from this account.`
                : googleConfigured
                  ? "Connect to let ISA read your inbox, send approved emails and see your meetings."
                  : "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_URL"}
            </p>
          </div>
          {googleConfigured ? (
            <a
              href="/api/google/connect"
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium"
            >
              {google ? "Reconnect" : "Connect Google"}
            </a>
          ) : null}
        </div>
      </section>

      <a href="/meetings" className="block rounded-xl border border-line bg-surface p-4 text-sm hover:border-accent">
        <span className="font-medium">Meetings</span>
        <span className="text-muted"> · Send ISA Notetaker to a call, and choose whether it joins your calendar meetings by itself →</span>
      </a>
    </div>
  );
}
