# ISA

ISA is a project assistant for business analysts, product managers, TPMs and managers who hold several projects at once. It follows requirements and decisions across meetings, email and Slack, files each one under the right project, flags where Jira drifts from what was agreed, tracks who owes what, drafts status reports per audience, and proposes Jira and message updates that run only after you approve them. You stay the human check between the conversations and Jira.

Investor prototype. The plan lives in the project's ISA plan document.

## How it works

1. **Events** come in: meeting transcripts, emails, Slack messages.
2. **Sort**: Claude decides which project and requirement each event belongs to, or asks you when unsure.
3. **Propose**: Claude drafts the ticket changes and who to contact, as a card in the Inbox.
4. **Approve**: you approve or dismiss, or ask ISA in the chat to change the draft. Only approved actions reach Jira, Slack or email.

A background worker inside the web server runs every 10 seconds: it checks meeting bots and stores finished transcripts, reads Slack and Gmail every 30 seconds, schedules the bot for calendar meetings every 2 minutes (when auto-join is on), and sorts new events. Set `ISA_WORKER=off` to stop it.

Connecting each service is described in [docs/SETUP.md](docs/SETUP.md).

## Demo data

`npm run seed:demo -- --reset` loads the story of one PM keeping three projects on track (one at risk, one needing attention, one on track). It **replaces** all projects, items, suggestions and reminders, and its Jira keys are made up: use it on a local or demo database with `ISA_WORKER=off`, never on the real one.

## Run locally

Needs Node 22 and Postgres 16.

```sh
npm install
cp .env.example .env        # fill in values
npm run db:migrate
npm run seed                # optional: one sample proposal
npm run dev                 # http://localhost:3000, password = ISA_PASSWORD
```

## Checks

```sh
npm run typecheck
npm run lint
npm test                    # uses TEST_DATABASE_URL, default postgres://isa:isa@localhost:5432/isa_test
```

## Deploy (Railway)

Create a Railway project with a Postgres database and this repository as a service. Set the variables from `.env.example` on the service, with `DATABASE_URL` referencing the Railway Postgres. `railway.json` runs the migrations before each start.

## Logs

The server writes one JSON line per log entry (`level`, `message`, ids, counts, durations), which Railway shows as structured logs. Useful filters in Railway: `@level:error`, `"call failed"` (an outside service: Jira, Slack, Recall, Google, Confluence, Claude), `"action failed"` (an approved step that did not run), `"event processing failed"`, `"request failed"` (any page, server action or API route). The first lines after a start list which integrations are configured. Set `LOG_LEVEL=debug` to also see every successful outside call and idle worker passes. Logs carry ids and error kinds only, never message, email or transcript text, tokens or email addresses.

## Layout

| Path | What |
| --- | --- |
| `src/db/schema.ts` | Projects, requirements, events, proposals, actions, rules, chat, connections |
| `src/lib/plan.ts` | The proposal plan and sort-result shapes, shared with Claude's structured outputs |
| `src/lib/executor.ts` | Runs an approved proposal: requirement changes, then each outside action, all logged |
| `src/lib/jira.ts` | Jira Cloud REST client |
| `src/lib/brain/` | Claude: sorting, drafting proposals, the chat and its tools |
| `src/lib/worker.ts`, `src/lib/runtime.ts` | The background worker |
| `src/lib/recall.ts`, `src/lib/calendar.ts` | Meeting bot (Recall.ai) and calendar auto-join |
| `src/lib/slack.ts`, `src/lib/slack-poll.ts` | Slack: read as the owner, post as the ISA bot |
| `src/lib/google.ts`, `src/lib/gmail.ts` | Google sign-in, Gmail read and send |
| `src/app/(app)` | Home, Reminders, Meetings (Join a meeting), Connections, Settings. Home: sidebar of projects; each project shows what needs you, the chat, and an Activity / Requirements / People side panel), Connections, Settings |
