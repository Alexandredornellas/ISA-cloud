# CLAUDE.md

ISA investor prototype. Speed to demo comes first; keep changes small and the UI simple.

Read `AGENTS.md` (Next.js 16 notes) and `README.md` first.

## Rules that must hold

- **Nothing reaches Jira, Slack or email without an approved proposal.** Only `src/lib/executor.ts` calls outside write APIs. The chat may create or change proposals, never act directly.
- Recording is announced: the meeting bot joins under a visible name. Never add a silent mode.
- Secrets come from environment variables only. Never commit `.env`, keys or tokens, and never log them.
- Do not log message, email or transcript content. Log ids, counts and error kinds.
- Migrations: change `src/db/schema.ts`, then `npm run db:generate`. Never edit a migration that has been pushed.

## Commands

`npm run dev`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:migrate`, `npm run seed`.
Run typecheck, lint and test before saying something is done.

## Git

Small Conventional Commits (`feat:`, `fix:`, `docs:`, ...). Push after each logical change. Never force-push.
