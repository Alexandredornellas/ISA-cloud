import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// The build imports this module without a database, so a missing URL only fails on the first
// query (postgres-js connects lazily), not at import.
const url = process.env.DATABASE_URL || "postgres://DATABASE_URL-is-not-set@localhost:1/missing";

// Reuse one connection pool across hot reloads in development.
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> };
const sql = globalForDb.sql ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;

export const db = drizzle(sql, { schema });
export { schema };
