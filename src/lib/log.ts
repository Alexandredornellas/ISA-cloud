// Structured logs for Railway: one JSON line per entry, with a level, an event name and ids.
// Never pass message, email or transcript content, or anything secret, in `ctx`: ids, counts,
// statuses and durations only. Error text is shortened and scrubbed of tokens and addresses.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, string | number | boolean | null | undefined>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const wanted = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return ORDER[wanted] ?? ORDER.info;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/xox[abposr]-[A-Za-z0-9-]+/g, "[slack-token]"],
  [/sk-ant-[A-Za-z0-9_-]+/g, "[anthropic-key]"],
  [/ya29\.[A-Za-z0-9._-]+/g, "[google-token]"],
  [/(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/([?&](?:token|key|code|access_token|refresh_token|client_secret|api_key)=)[^&\s"]+/gi, "$1[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

/** Error text safe to log: secrets and email addresses removed, at most 300 characters. */
export function scrub(text: string, max = 300): string {
  // Drizzle puts the query's values after "params:": they can be message or email text.
  let out = text.replace(/\bparams:[\s\S]*$/, "params: [omitted]");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** A path without its query string, which can hold search text or tokens. */
export function pathOnly(path: string): string {
  return path.split("?")[0];
}

/** The parts of an error that help find a failure: kind, HTTP status, codes and a scrubbed message. */
export function describeError(err: unknown): Record<string, string | number> {
  if (!(err instanceof Error)) return { errorKind: typeof err, errorMessage: scrub(String(err), 120) };
  const e = err as Error & {
    status?: unknown;
    code?: unknown;
    requestID?: unknown;
    constraint_name?: unknown;
    table_name?: unknown;
    digest?: unknown;
    cause?: unknown;
  };
  // The production build shortens class names, so prefer an explicit `name` ("JiraError").
  const ctor = e.constructor?.name ?? "";
  const out: Record<string, string | number> = {
    errorKind: e.name && e.name !== "Error" ? e.name : ctor.length > 3 ? ctor : "Error",
    errorMessage: scrub(e.message),
  };
  if (typeof e.status === "number") out.status = e.status;
  if (typeof e.code === "string" || typeof e.code === "number") out.code = e.code;
  if (typeof e.requestID === "string") out.requestId = e.requestID;
  // Postgres: which table and constraint, never the row values (`detail`).
  if (typeof e.table_name === "string") out.table = e.table_name;
  if (typeof e.constraint_name === "string") out.constraint = e.constraint_name;
  if (typeof e.digest === "string") out.digest = e.digest;
  // fetch() failures hide the network reason (ECONNRESET, ENOTFOUND, timeout) in `cause`.
  // Drizzle wraps the Postgres error the same way.
  const cause = e.cause as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  if (cause && typeof cause === "object") {
    if (typeof cause.code === "string") out.causeCode = cause.code;
    if (typeof cause.name === "string" && cause.name !== "Error" && cause.name.length > 3) out.causeKind = cause.name;
    if (typeof cause.message === "string" && cause.message) out.causeMessage = scrub(cause.message, 160);
  }
  if (e.stack && process.env.LOG_STACKS !== "off") {
    // The first frames only: enough to find the line, without the message (already scrubbed above).
    out.stack = e.stack
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("at "))
      .slice(0, 5)
      .join(" | ");
  }
  return out;
}

function write(level: LogLevel, event: string, ctx: LogContext = {}, err?: unknown) {
  if (ORDER[level] < threshold()) return;
  const entry: Record<string, unknown> = { level, message: event, time: new Date().toISOString() };
  for (const [k, v] of Object.entries(ctx)) if (v !== undefined) entry[k] = v;
  if (err !== undefined) Object.assign(entry, describeError(err));
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ level, message: event, time: entry.time, note: "log entry could not be serialized" });
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, ctx?: LogContext) => write("debug", event, ctx),
  info: (event: string, ctx?: LogContext) => write("info", event, ctx),
  warn: (event: string, ctx?: LogContext, err?: unknown) => write("warn", event, ctx, err),
  error: (event: string, err: unknown, ctx?: LogContext) => write("error", event, ctx, err),
};

/**
 * Log one call to an outside service: a warning with status and duration when it fails, a debug
 * line when it works. Rethrows, so callers keep handling the error as before. `expected` marks
 * statuses that are a normal answer (a 404 for "deleted ticket"), which are logged at debug only.
 */
export async function traced<T>(
  service: string,
  op: string,
  fn: () => Promise<T>,
  opts: { ctx?: LogContext; expected?: (err: unknown) => boolean } = {},
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - started;
    if (ms > 10_000) log.warn(`${service} call slow`, { service, op, ms, ...opts.ctx });
    else log.debug(`${service} call ok`, { service, op, ms, ...opts.ctx });
    return result;
  } catch (err) {
    const ms = Date.now() - started;
    if (opts.expected?.(err)) log.debug(`${service} call answered no`, { service, op, ms, ...opts.ctx, ...pick(err) });
    else log.warn(`${service} call failed`, { service, op, ms, ...opts.ctx }, err);
    throw err;
  }
}

function pick(err: unknown): LogContext {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? { status } : {};
}

/** For `.catch(...)`: log the failure and return a fallback, so one source never stops the rest. */
export function logAndReturn<T>(event: string, fallback: T, ctx?: LogContext) {
  return (err: unknown): T => {
    log.error(event, err, ctx);
    return fallback;
  };
}
