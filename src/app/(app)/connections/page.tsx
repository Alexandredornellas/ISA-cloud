import { JiraClient, jiraConfigFromEnv } from "@/lib/jira";
import { liveSlack } from "@/lib/runtime";
import { GoogleClient, googleConfigFromEnv } from "@/lib/google";
import { confluenceStatus } from "@/lib/confluence";
import { addConfluencePage } from "./actions";
import { SubmitButton } from "@/components/SubmitButton";

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

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ confluence?: string }> }) {
  const { confluence: confluenceMessage } = await searchParams;
  const statuses: Status[] = [
    envStatus(
      "Claude",
      ["ANTHROPIC_API_KEY"],
      "API key set",
      "Set ANTHROPIC_API_KEY",
    ),
    await jiraStatus(),
    { name: "Confluence", ...(await confluenceStatus()) },
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
          Sources
        </h1>
        <p className="mt-1 text-sm text-muted">
          Where ISA gathers context (meetings, email, Slack, Confluence, Jira)
          and where she acts after you approve (Jira, Slack, email).
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
        <form action={addConfluencePage} className="mt-3 rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Add a Confluence page to memory</p>
          <p className="mt-0.5 text-sm text-muted">
            Paste a spec, PRD or meeting notes page. ISA reads it (never edits it), files it under the
            right projects, and keeps its decisions with the source.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              name="page"
              required
              placeholder="https://your-site.atlassian.net/wiki/spaces/…/pages/123456/…"
              aria-label="Confluence page link"
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm"
            />
            <SubmitButton className="bg-accent text-white">Add page</SubmitButton>
          </div>
          {confluenceMessage ? <p className="mt-2 text-sm" role="status">{confluenceMessage}</p> : null}
        </form>
      </section>

      <a href="/meetings" className="block rounded-xl border border-line bg-surface p-4 text-sm hover:border-accent">
        <span className="font-medium">Meetings</span>
        <span className="text-muted"> · Send ISA Notetaker to a call, and choose whether it joins your calendar meetings by itself →</span>
      </a>
    </div>
  );
}
