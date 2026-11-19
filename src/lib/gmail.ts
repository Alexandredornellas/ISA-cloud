import { db, schema } from "@/db";
import { GoogleError, type GoogleClient } from "@/lib/google";
import type { Person } from "@/lib/plan";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY = 20_000;

type Google = Pick<GoogleClient, "get" | "send" | "state" | "saveState">;

type Part = {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
};
export type GmailMessage = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: Part };

/** Read new inbox emails since the last pass and store each as an event. */
export async function pollGmail(google: Google): Promise<number> {
  const state = await google.state();
  if (!state.historyId) {
    // First pass: start from now.
    const profile = await google.get<{ historyId: string }>(`${API}/profile`);
    await google.saveState({ ...state, historyId: profile.historyId });
    return 0;
  }

  let history: { history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string };
  try {
    history = await google.get(`${API}/history`, {
      startHistoryId: state.historyId,
      historyTypes: "messageAdded",
      labelId: "INBOX",
    });
  } catch (err) {
    // A cursor that is too old is answered with 404: start again from now.
    if (err instanceof GoogleError && err.status === 404) {
      await google.saveState({ ...state, historyId: "" });
      return 0;
    }
    throw err;
  }

  const ids = new Set<string>();
  for (const h of history.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      const labels = added.message.labelIds ?? [];
      if (labels.includes("INBOX") && !labels.includes("SPAM") && !labels.includes("CATEGORY_PROMOTIONS")) ids.add(added.message.id);
    }
  }

  let stored = 0;
  for (const id of ids) {
    const msg = await google.get<GmailMessage>(`${API}/messages/${id}`, { format: "full" });
    const values = emailEvent(msg);
    const [row] = await db.insert(schema.events).values(values).onConflictDoNothing().returning({ id: schema.events.id });
    if (row) stored += 1;
  }
  await google.saveState({ ...state, historyId: history.historyId });
  return stored;
}

export function header(msg: GmailMessage, name: string): string | null {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** Turn a Gmail message into an ISA event. */
export function emailEvent(msg: GmailMessage) {
  const from = header(msg, "From") ?? "";
  const to = header(msg, "To") ?? "";
  const cc = header(msg, "Cc") ?? "";
  const subject = header(msg, "Subject") || "(no subject)";
  const sender = parseAddresses(from)[0] ?? null;
  const people: Person[] = [];
  for (const p of [...parseAddresses(from), ...parseAddresses(to), ...parseAddresses(cc)]) {
    if (!people.some((x) => x.email === p.email)) people.push({ name: p.name, email: p.email, slackUserId: null, role: null });
  }
  const body = stripQuoted(bodyText(msg.payload)).slice(0, MAX_BODY);
  return {
    source: "gmail" as const,
    externalId: msg.id,
    title: subject,
    author: from || null,
    participants: people,
    occurredAt: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
    content: [`From: ${from}`, `To: ${to}`, cc ? `Cc: ${cc}` : null, `Subject: ${subject}`, "", body].filter((l) => l !== null).join("\n"),
    url: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
    replyTo: { threadId: msg.threadId, to: sender?.email ?? "", subject },
  };
}

export function parseAddresses(list: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  // Split on commas that are not inside quotes.
  for (const raw of list.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(.*)<([^>]+)>$/);
    const email = (m ? m[2] : s).trim().toLowerCase();
    if (!email.includes("@")) continue;
    const name = m ? m[1].trim().replace(/^"|"$/g, "") : "";
    out.push({ name: name || email, email });
  }
  return out;
}

function decode(data?: string): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** The plain-text body, or the HTML body turned into text. */
export function bodyText(part?: Part): string {
  if (!part) return "";
  const plain = findPart(part, "text/plain");
  if (plain) return decode(plain.body?.data);
  const html = findPart(part, "text/html");
  if (html) return htmlToText(decode(html.body?.data));
  return decode(part.body?.data);
}

function findPart(part: Part, mime: string): Part | null {
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop the quoted earlier messages of a reply; the thread's earlier emails are their own events. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .+wrote:\s*$/.test(l) || (/^On /.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? ""))) break;
    if (/^-+\s*Original Message\s*-+$/i.test(l) || /^_{10,}$/.test(l.trim())) break;
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** Sends email from the connected Gmail account, as a reply in the thread when one is given. */
export class GmailSender {
  constructor(private readonly google: Pick<GoogleClient, "get" | "send">) {}

  async send(input: { to: string[]; subject: string; body: string; threadId: string | null }): Promise<{ id: string }> {
    const headers = [`To: ${input.to.join(", ")}`, `Subject: ${encodeHeader(input.subject)}`];
    if (input.threadId) {
      const thread = await this.google.get<{ messages: GmailMessage[] }>(`${API}/threads/${input.threadId}`, {
        format: "metadata",
        metadataHeaders: ["Message-ID", "References"],
      });
      const last = thread.messages.at(-1);
      const messageId = last ? header(last, "Message-ID") : null;
      if (messageId) {
        const refs = [header(last!, "References"), messageId].filter(Boolean).join(" ");
        headers.push(`In-Reply-To: ${messageId}`, `References: ${refs}`);
      }
    }
    headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit");
    const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.body}`, "utf8").toString("base64url");
    const sent = await this.google.send<{ id: string }>("POST", `${API}/messages/send`, {
      raw,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
    return { id: sent.id };
  }
}

function encodeHeader(value: string): string {
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
