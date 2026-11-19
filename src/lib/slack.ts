// Slack Web API client. ISA reads with the owner's user token (channels, private channels and
// DMs the owner is in) and posts with the bot token, so its messages show as "ISA".

export type SlackConfig = { userToken: string; botToken: string };

export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  latest_reply?: string;
  reply_count?: number;
};

export type SlackConversation = {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  user?: string;
};

export type SlackUser = { id: string; name: string; email: string | null };

export function slackConfigFromEnv(): SlackConfig {
  const userToken = process.env.SLACK_USER_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!userToken || !botToken) throw new Error("Slack is not configured: set SLACK_USER_TOKEN and SLACK_BOT_TOKEN");
  return { userToken, botToken };
}

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackError";
  }
}

export class SlackClient {
  private users = new Map<string, SlackUser>();

  constructor(
    private readonly cfg: SlackConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: Record<string, string | number | undefined>, as: "user" | "bot" = "user"): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${as === "user" ? this.cfg.userToken : this.cfg.botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (res.status === 429) throw new SlackError(method, "rate_limited");
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new SlackError(method, json.error ?? `http_${res.status}`);
    return json;
  }

  async whoAmI(): Promise<{ team: string; user: string; userId: string }> {
    const r = await this.call<{ team: string; user: string; user_id: string }>("auth.test", {});
    return { team: r.team, user: r.user, userId: r.user_id };
  }

  /** Conversations the owner is a member of: channels, private channels, group DMs and DMs. */
  async conversations(): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.call<{ channels: SlackConversation[]; response_metadata?: { next_cursor?: string } }>(
        "users.conversations",
        { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: 200, cursor },
      );
      out.push(...r.channels);
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** The latest top-level messages of a conversation, newest first. */
  async history(channel: string, limit = 50): Promise<SlackMessage[]> {
    const r = await this.call<{ messages: SlackMessage[] }>("conversations.history", { channel, limit });
    return r.messages;
  }

  /** A thread: the parent message first, then the replies in order. */
  async replies(channel: string, ts: string): Promise<SlackMessage[]> {
    const r = await this.call<{ messages: SlackMessage[] }>("conversations.replies", { channel, ts, limit: 200 });
    return r.messages;
  }

  async user(id: string): Promise<SlackUser> {
    const cached = this.users.get(id);
    if (cached) return cached;
    let user: SlackUser = { id, name: id, email: null };
    try {
      const r = await this.call<{
        user: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string; email?: string } };
      }>("users.info", { user: id });
      const u = r.user;
      user = {
        id,
        name: u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || id,
        email: u.profile?.email ?? null,
      };
    } catch {
      // Unknown or external users keep their id as the name.
    }
    this.users.set(id, user);
    return user;
  }

  /** Post as the ISA bot. A user id (U...) as channel sends a DM from ISA. */
  async postMessage(channel: string, text: string, threadTs: string | null): Promise<{ ts: string }> {
    const r = await this.call<{ ts: string }>(
      "chat.postMessage",
      { channel, text, thread_ts: threadTs ?? undefined, unfurl_links: "false" },
      "bot",
    );
    return { ts: r.ts };
  }
}
