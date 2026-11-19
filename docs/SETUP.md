# Connecting ISA

Every key goes into the Railway service's **Variables** (or `.env` locally). Never paste keys in chat or commit them.
The Connections page shows which services are connected.

## 1. Railway (hosting)

1. Create a project at railway.com, add **Postgres**, then **Deploy from GitHub repo** with this repository.
2. On the app service, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}` and `ISA_PASSWORD` to the password you will log in with.
3. Under **Settings, Networking**, generate a domain. Set `APP_URL` to it, e.g. `https://isa-production.up.railway.app`.

## 2. Claude

Create a key at console.anthropic.com (Settings, API keys). Set `ANTHROPIC_API_KEY`.

## 3. Jira

1. On your Jira Cloud site, create a Scrum or Kanban project (for example key `ISA`).
2. Create an API token at id.atlassian.com/manage-profile/security/api-tokens.
3. Set `JIRA_SITE` (`yourname.atlassian.net`), `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`.

## 4. Meeting bot (Recall.ai)

1. Sign up at recall.ai and create an API key. Note your region (shown in the dashboard URL, e.g. `us-west-2`).
2. Set `RECALL_API_KEY` and `RECALL_REGION`.
3. For Google Meet: the bot asks to join, and the host admits "ISA Notetaker". Schedule it 10+ minutes ahead so it is on time.

## 5. Slack

1. Go to api.slack.com/apps, **Create New App, From a manifest**, pick your workspace, and paste `docs/slack-app-manifest.json`.
2. **Install to Workspace** and allow.
3. Under **OAuth & Permissions**, copy the **User OAuth Token** (`xoxp-...`) to `SLACK_USER_TOKEN` and the **Bot User OAuth Token** (`xoxb-...`) to `SLACK_BOT_TOKEN`.
4. ISA reads every channel and DM you are in. It posts as **ISA**: invite it (`/invite @ISA`) to private channels where it should reply.

## 6. Google (Gmail and Calendar)

1. At console.cloud.google.com, create a project. Enable the **Gmail API** and **Google Calendar API**.
2. **OAuth consent screen**: External, app name ISA, add your Gmail address as a **test user**. (In testing mode Google asks you to sign in again every 7 days.)
3. **Credentials, Create credentials, OAuth client ID**: Web application. Authorized redirect URI: `<APP_URL>/api/google/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, redeploy, then press **Connect Google** on the Connections page.
5. Turn on **Join my calendar meetings** if ISA should join every meeting with a video link.
