import { JiraClient, jiraConfigFromEnv } from "@/lib/jira";

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

function envStatus(name: string, vars: string[], okDetail: string, missingDetail: string): Status {
  const ok = vars.every((v) => !!process.env[v]);
  return { name, ok, detail: ok ? okDetail : missingDetail };
}

export default async function ConnectionsPage() {
  const statuses: Status[] = [
    envStatus("Claude", ["ANTHROPIC_API_KEY"], "API key set", "Set ANTHROPIC_API_KEY"),
    await jiraStatus(),
    envStatus("Meeting bot", ["RECALL_API_KEY"], "Recall.ai key set", "Coming on day 2"),
    { name: "Gmail", ok: false, detail: "Coming on day 4" },
    { name: "Slack", ok: false, detail: "Coming on day 4" },
  ];

  return (
    <div>
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
    </div>
  );
}
