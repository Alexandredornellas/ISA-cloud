// Google OAuth plus the Gmail and Calendar calls ISA needs. Tokens live in the connections table.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function googleConfigFromEnv(): GoogleConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    throw new Error("Google is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_URL");
  }
  return { clientId, clientSecret, redirectUri: `${appUrl.replace(/\/$/, "")}/api/google/callback` };
}

export function googleAuthUrl(cfg: GoogleConfig, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return u.toString();
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

async function tokenRequest(params: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json()) as TokenResponse & { error?: string };
  if (!res.ok || json.error) throw new Error(`Google sign-in failed: ${json.error ?? res.status}`);
  return json;
}

/** Finish the OAuth flow and save the tokens. Returns the connected Google account. */
export async function connectGoogle(cfg: GoogleConfig, code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const t = await tokenRequest(
    { code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" },
    fetchImpl,
  );
  const account = emailFromIdToken(t.id_token) ?? "Google account";
  const values = {
    provider: "google",
    account,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000),
    scope: t.scope ?? null,
    state: {},
    updatedAt: new Date(),
  };
  await db.insert(schema.connections).values(values).onConflictDoUpdate({ target: schema.connections.provider, set: values });
  return account;
}

function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

/** Gmail and Calendar calls as the connected user, refreshing the access token when needed. */
export class GoogleClient {
  constructor(
    private readonly cfg: GoogleConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static async connection() {
    return db.query.connections.findFirst({ where: eq(schema.connections.provider, "google") });
  }

  private async token(): Promise<string> {
    const conn = await GoogleClient.connection();
    if (!conn) throw new Error("Google is not connected");
    if (conn.expiresAt && conn.expiresAt.getTime() > Date.now()) return conn.accessToken;
    if (!conn.refreshToken) throw new Error("Google sign-in expired: connect Google again");
    const t = await tokenRequest(
      { refresh_token: conn.refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: "refresh_token" },
      this.fetchImpl,
    );
    await db
      .update(schema.connections)
      .set({ accessToken: t.access_token, expiresAt: new Date(Date.now() + (t.expires_in - 60) * 1000), updatedAt: new Date() })
      .where(eq(schema.connections.id, conn.id));
    return t.access_token;
  }

  async get<T>(url: string, params: Record<string, string | string[] | undefined> = {}): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else if (v !== undefined) u.searchParams.set(k, v);
    }
    return this.send<T>("GET", u.toString());
  }

  async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GoogleError(res.status, `Google ${method} ${new URL(url).pathname} failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async state(): Promise<Record<string, string>> {
    return (await GoogleClient.connection())?.state ?? {};
  }

  async saveState(state: Record<string, string>) {
    await db
      .update(schema.connections)
      .set({ state, updatedAt: new Date() })
      .where(eq(schema.connections.provider, "google"));
  }
}

export function liveGoogle(): GoogleClient | null {
  try {
    return new GoogleClient(googleConfigFromEnv());
  } catch {
    return null;
  }
}
