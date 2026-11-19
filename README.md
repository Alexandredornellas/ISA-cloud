# ISA

ISA follows requirements across meetings, email and Slack, files each one under the right project, and proposes Jira and message updates that run only after you approve them.

Investor prototype. The plan lives in the project's ISA plan document.

## How it works

1. **Events** come in: meeting transcripts, emails, Slack messages.
2. **Sort**: Claude decides which project and requirement each event belongs to, or asks you when unsure.
3. **Propose**: Claude drafts the ticket changes and who to contact, as a card in the Inbox.
4. **Approve**: you approve, edit or dismiss. Only approved actions reach Jira, Slack or email.

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

## Layout

| Path | What |
| --- | --- |
| `src/db/schema.ts` | Projects, requirements, events, proposals, actions, rules, chat, connections |
| `src/lib/plan.ts` | The proposal plan and sort-result shapes, shared with Claude's structured outputs |
| `src/lib/executor.ts` | Runs an approved proposal: requirement changes, then each outside action, all logged |
| `src/lib/jira.ts` | Jira Cloud REST client |
| `src/app/(app)` | Inbox, Projects, Connections |
