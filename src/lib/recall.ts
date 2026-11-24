// Recall.ai meeting-bot client. The bot joins Zoom, Google Meet or Teams under a visible
// name, transcribes with speaker names, and ISA downloads the transcript when the call ends.

export type RecallConfig = { apiKey: string; region: string };

export type TranscriptSegment = {
  participant: { name: string | null; email?: string | null };
  words: { text: string; start_timestamp?: { relative: number } | null }[];
};

export type BotState = {
  status: "scheduled" | "in_call" | "processing" | "done" | "failed";
  detail: string | null;
  transcriptUrl: string | null;
};

export const BOT_NAME = "ISA Notetaker";

export function recallConfigFromEnv(): RecallConfig {
  const apiKey = process.env.RECALL_API_KEY;
  if (!apiKey) throw new Error("Recall.ai is not configured: set RECALL_API_KEY");
  return { apiKey, region: process.env.RECALL_REGION || "us-east-1" };
}

/** Which platform a meeting link belongs to, or null when ISA cannot join it. */
export function platformOf(url: string): "zoom" | "meet" | "teams" | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "zoom.us" || host.endsWith(".zoom.us")) return "zoom";
  if (host === "meet.google.com") return "meet";
  if (host === "teams.microsoft.com" || host === "teams.live.com") return "teams";
  return null;
}

/** The meeting a link points to, without its query (passcodes and tracking differ between copies of one link). */
export function meetingKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
}

export class RecallClient {
  constructor(
    private readonly cfg: RecallConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://${this.cfg.region}.recall.ai/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Token ${this.cfg.apiKey}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Recall.ai ${method} ${path} failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    // Some calls (leave_call) may answer with an empty body.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Send the bot to a meeting now, or at joinAt (at least 10 minutes ahead is guaranteed on time). */
  async createBot(meetingUrl: string, joinAt: Date | null): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/bot/", {
      meeting_url: meetingUrl,
      bot_name: BOT_NAME,
      ...(joinAt ? { join_at: joinAt.toISOString() } : {}),
      recording_config: {
        transcript: {
          // Streaming transcription during the call, so the transcript is ready at hang-up.
          provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
          diarization: { use_separate_streams_when_available: true },
        },
      },
      // Announce the recording in the meeting chat.
      chat: {
        on_bot_join: {
          send_to: "everyone",
          message: "Hi, I'm ISA, taking notes for this meeting. The transcript is used to update project tickets.",
        },
      },
    });
  }

  /** Ask the bot to leave the call now. Recall then finishes the transcript as after any call. */
  async leaveCall(botId: string): Promise<void> {
    await this.request("POST", `/bot/${encodeURIComponent(botId)}/leave_call/`);
  }

  async getBotState(botId: string): Promise<BotState> {
    const bot = await this.request<RawBot>("GET", `/bot/${encodeURIComponent(botId)}/`);
    return botState(bot);
  }

  async downloadTranscript(url: string): Promise<TranscriptSegment[]> {
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`Transcript download failed (${res.status})`);
    return (await res.json()) as TranscriptSegment[];
  }
}

type RawBot = {
  status_changes?: { code: string; sub_code?: string | null }[];
  status?: { code: string; sub_code?: string | null };
  recordings?: {
    media_shortcuts?: {
      transcript?: { status?: { code: string }; data?: { download_url?: string | null } } | null;
    } | null;
  }[];
};

const IN_CALL = new Set(["joining_call", "in_waiting_room", "in_call_not_recording", "recording_permission_allowed", "in_call_recording"]);
const ENDED = new Set(["call_ended", "done"]);

/** Map Recall's bot record to ISA's simpler state. */
export function botState(bot: RawBot): BotState {
  const last = bot.status?.code ?? bot.status_changes?.at(-1)?.code ?? "ready";
  const sub = bot.status?.sub_code ?? bot.status_changes?.at(-1)?.sub_code ?? null;
  const transcript = bot.recordings?.at(-1)?.media_shortcuts?.transcript;
  const transcriptUrl = transcript?.status?.code === "done" ? (transcript.data?.download_url ?? null) : null;

  if (last === "fatal" || last === "recording_permission_denied") {
    return { status: "failed", detail: sub ?? last, transcriptUrl: null };
  }
  if (transcript?.status?.code === "failed") {
    return { status: "failed", detail: "Transcription failed", transcriptUrl: null };
  }
  if (transcriptUrl) return { status: "done", detail: null, transcriptUrl };
  if (ENDED.has(last)) {
    // The call ended without any recording, e.g. the bot was never admitted.
    if (last === "done" && !(bot.recordings?.length)) {
      return { status: "failed", detail: sub ?? "The bot did not record this meeting", transcriptUrl: null };
    }
    return { status: "processing", detail: null, transcriptUrl: null };
  }
  if (IN_CALL.has(last)) return { status: "in_call", detail: last === "in_waiting_room" ? "Waiting to be admitted" : null, transcriptUrl: null };
  return { status: "scheduled", detail: null, transcriptUrl: null };
}

/** Turn Recall's word-level transcript into "Name: sentence" lines plus the list of speakers. */
export function formatTranscript(segments: TranscriptSegment[]): { text: string; speakers: string[] } {
  const lines: string[] = [];
  const speakers: string[] = [];
  let current: { name: string; words: string[] } | null = null;
  for (const seg of segments) {
    const name = seg.participant?.name?.trim() || "Unknown speaker";
    if (!speakers.includes(name)) speakers.push(name);
    const words = seg.words.map((w) => w.text);
    if (current && current.name === name) {
      current.words.push(...words);
    } else {
      if (current) lines.push(`${current.name}: ${current.words.join(" ")}`);
      current = { name, words };
    }
  }
  if (current) lines.push(`${current.name}: ${current.words.join(" ")}`);
  return { text: lines.join("\n"), speakers };
}
