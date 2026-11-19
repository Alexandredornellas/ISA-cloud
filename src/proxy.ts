import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";

// Everything except the login page and incoming webhooks needs the session cookie.
export async function proxy(request: NextRequest) {
  const expected = await sessionToken();
  if (!expected) {
    return new NextResponse("ISA_PASSWORD is not set on the server.", { status: 500 });
  }
  if (request.cookies.get(SESSION_COOKIE)?.value === expected) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!login|api/webhooks|_next/static|_next/image|favicon.ico).*)"],
};
