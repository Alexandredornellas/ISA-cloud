import { revalidatePath } from "next/cache";
import { sendChat } from "@/lib/brain/chat";
import { log } from "@/lib/log";

// The chat runs here, not as a server action: a pending server action holds up page navigation,
// so the app froze while ISA was thinking. A plain request lets the owner move around meanwhile.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? v : null);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { text?: unknown; projectId?: unknown; proposalId?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: null });
  try {
    await sendChat(text, uuid(body.projectId), uuid(body.proposalId));
  } catch (err) {
    log.error("chat failed", err);
    return Response.json({ error: "ISA could not answer. Check the Anthropic key on the Connections page and try again." });
  }
  revalidatePath("/", "layout");
  return Response.json({ error: null });
}
