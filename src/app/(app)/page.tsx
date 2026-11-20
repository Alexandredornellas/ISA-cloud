import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { chatTranscript } from "@/lib/brain/chat";
import { channels, decisions, notifications } from "@/lib/channels";
import { activity } from "@/lib/activity";
import { ChannelView } from "@/components/ChannelView";
import { Workspace, type PanelTab } from "@/components/Workspace";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PeopleAndRules, RequirementList } from "@/components/ProjectPanels";
import { clearChatMessages } from "./chat/actions";

export const dynamic = "force-dynamic";

const PROJECT_EXAMPLES = [
  "What is still open here, and what is blocking it?",
  "What changed in Jira on these tickets?",
  "What should I ask the stakeholders next?",
];

/** ISA's home: Ask ISA (general) or one project, with what needs you, the chat, and a side panel. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const { c, ask } = await searchParams;
  const all = await channels();
  const current = (typeof c === "string" && all.find((ch) => ch.id === c)) || all[0];
  const projectId = current.id;

  const [notes, chat, log, feed] = await Promise.all([notifications(projectId), chatTranscript(projectId), decisions(projectId), activity(projectId)]);
  const messages = [
    ...chat.map((m) => ({ id: m.id, role: m.role, text: m.text, used: m.used, at: m.at })),
    ...log.map((l) => ({ id: `log-${l.id}`, role: "log" as const, text: `${l.at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${l.text}`, at: l.at })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((m) => ({ id: m.id, role: m.role, text: m.text, used: "used" in m ? m.used : undefined }));

  const project = projectId ? await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) }) : null;
  const [requirements, rules] = projectId
    ? await Promise.all([
        db.query.requirements.findMany({ where: eq(schema.requirements.projectId, projectId), orderBy: asc(schema.requirements.createdAt) }),
        db.query.projectRules.findMany({ where: eq(schema.projectRules.projectId, projectId) }),
      ])
    : [[], []];
  const open = requirements.filter((r) => r.status !== "done" && r.status !== "dropped").length;
  const tickets = requirements.filter((r) => r.jiraIssueKey).length;

  const tabs: PanelTab[] = [
    { id: "activity", label: "Activity", icon: "clock", content: <ActivityFeed entries={feed} showProject={!projectId} /> },
    ...(project
      ? [
          { id: "requirements", label: "Requirements", icon: "list" as const, count: open, content: <RequirementList requirements={requirements} /> },
          { id: "people", label: "People & rules", icon: "users" as const, content: <PeopleAndRules projectId={project.id} people={project.people} rules={rules} /> },
        ]
      : []),
  ];

  const header = (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{project ? project.name : "Ask ISA"}</h1>
        {chat.length ? (
          <form action={clearChatMessages}>
            {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
            <button className="rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink">New chat</button>
          </form>
        ) : null}
      </div>
      {project ? (
        <>
          {project.summary ? <p className="mt-1 line-clamp-2 text-sm text-muted">{project.summary}</p> : null}
          <p className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className={`rounded-full px-2 py-0.5 ${notes.length ? "bg-warn/15 font-medium text-warn" : "bg-ok/15 text-ok"}`}>
              {notes.length ? `${notes.length} need${notes.length === 1 ? "s" : ""} you` : "Up to date"}
            </span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-muted">
              {open} open requirement{open === 1 ? "" : "s"}
            </span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-muted">
              {tickets} Jira ticket{tickets === 1 ? "" : "s"}
            </span>
          </p>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted">Ask anything about your projects, meetings, email, Slack or Jira. Items ISA can&apos;t place in a project wait here.</p>
      )}
    </div>
  );

  return (
    <Workspace
      key={projectId ?? "general"}
      header={header}
      tabs={tabs}
      main={
        <ChannelView
          key={projectId ?? "general"}
          projectId={projectId}
          name={current.name}
          notifications={notes}
          messages={messages}
          examples={projectId ? PROJECT_EXAMPLES : undefined}
          initial={typeof ask === "string" ? ask : ""}
        />
      }
    />
  );
}
