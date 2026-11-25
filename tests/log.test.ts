import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, log, scrub, traced } from "@/lib/log";

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("scrubs tokens, secrets in URLs and email addresses", () => {
    const out = scrub("Bearer abc.def xoxb-123-456 sk-ant-api03-xyz ana@example.com https://x?token=s3cret&id=1");
    expect(out).not.toMatch(/abc\.def|xoxb-123|sk-ant-api03|ana@example\.com|s3cret/);
    expect(out).toContain("id=1");
  });

  it("keeps the useful parts of an error and never the Postgres row detail", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505", table_name: "events", constraint_name: "events_ext", detail: "Key (x)=(secret)" });
    const d = describeError(err);
    expect(d).toMatchObject({ errorMessage: "duplicate key", code: "23505", table: "events", constraint: "events_ext" });
    expect(JSON.stringify(d)).not.toContain("secret");
  });

  it("writes one JSON line per entry", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("jira poll failed", Object.assign(new Error("Jira GET /x failed (401)"), { status: 401 }), { source: "jira" });
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "error", message: "jira poll failed", source: "jira", status: 401 });
  });

  it("logs a failed outside call and rethrows; an expected answer is not a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(traced("slack", "chat.postMessage", () => Promise.reject(new Error("channel_not_found")))).rejects.toThrow("channel_not_found");
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({ message: "slack call failed", service: "slack", op: "chat.postMessage" });
    warn.mockClear();
    await expect(traced("jira", "GET /issue", () => Promise.reject(new Error("404")), { expected: () => true })).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
