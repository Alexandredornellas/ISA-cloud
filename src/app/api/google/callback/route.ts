import { NextResponse, type NextRequest } from "next/server";
import { connectGoogle, googleConfigFromEnv } from "@/lib/google";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Google sends the user back here after sign-in. */
export async function GET(request: NextRequest) {
  const cfg = googleConfigFromEnv();
  const back = new URL("/connections", cfg.redirectUri);
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || state !== request.cookies.get("isa_google_state")?.value) {
    back.searchParams.set("google", "failed");
    return NextResponse.redirect(back);
  }
  try {
    await connectGoogle(cfg, code);
    back.searchParams.set("google", "connected");
  } catch (err) {
    log.error("google connect failed", err);
    back.searchParams.set("google", "failed");
  }
  const res = NextResponse.redirect(back);
  res.cookies.delete("isa_google_state");
  return res;
}
