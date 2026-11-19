// Single-user password gate for the prototype. The session cookie holds a hash of
// the password, so changing ISA_PASSWORD signs everyone out.

export const SESSION_COOKIE = "isa_session";

export async function sessionToken(): Promise<string | null> {
  const password = process.env.ISA_PASSWORD;
  if (!password) return null;
  const data = new TextEncoder().encode(`isa-session:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
