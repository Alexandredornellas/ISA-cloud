import { liveStamp } from "@/lib/live";

// The browser polls this to learn when something new arrived (a Slack message, a meeting, a card),
// and then refreshes the page it is on. Behind the login like the rest of the app.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ stamp: await liveStamp() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("live stamp failed", { error: err instanceof Error ? err.name : "unknown" });
    return Response.json({ stamp: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
