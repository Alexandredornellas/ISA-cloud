import { JiraClient, jiraConfigFromEnv } from "@/lib/jira";
import type { Senders } from "@/lib/executor";
import { liveSlack } from "@/lib/runtime";

// The real outside services, built from environment variables. Missing ones are null,
// and the executor reports "<service> is not connected" for actions that need them.
export function liveSenders(): Senders {
  let jira: JiraClient | null = null;
  try {
    jira = new JiraClient(jiraConfigFromEnv());
  } catch {
    jira = null;
  }
  return { jira, slack: liveSlack(), email: null };
}
