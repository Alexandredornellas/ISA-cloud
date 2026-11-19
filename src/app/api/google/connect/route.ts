import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { googleAuthUrl, googleConfigFromEnv } from "@/lib/google";

export const dynamic = "force-dynamic";

/** Start Google sign-in for Gmail and Calendar. */
export async function GET() {
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(googleAuthUrl(googleConfigFromEnv(), state));
  res.cookies.set("isa_google_state", state, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 600, path: "/" });
  return res;
}
