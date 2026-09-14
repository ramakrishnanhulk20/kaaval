import { Pool, type PoolClient } from "pg";
import { tenantEnv } from "./env";

/**
 * One database, two ways of reaching it.
 *
 * Everything above this file speaks to Db and nothing else, so the same queries run
 * against the hosted Postgres in production and against an embedded Postgres in the
 * tests. The interface is deliberately tiny: parameters are always bound, never pasted
 * into the text, and multi statement text goes through exec, which is the only shape an
 * embedded Postgres accepts for a migration file.
 */
export interface Db {
  query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

export class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbError";
  }
}

/**
 * Two connections, no more.
 *
 * The connection string is the hosted pooled one, which already has a pooler in front of
 * it. Stacking a large pool of our own on top of that is the documented way to get
 * conflicts, so this keeps the smallest pool that still lets one page render while
 * another plan is running, and every borrowed connection is handed straight back.
 */
const MAX_CONNECTIONS = 2;

let pool: Pool | null = null;
let provided: Db | null = null;

/**
 * Points this layer at a database somebody else made, or back at the pool.
 *
 * The test harness passes its embedded Postgres in here, and a host that already owns a
 * connection can do the same. Passing null puts the pool back.
 */
export function setDatabase(db: Db | null): void {
  provided = db;
}

function poolOf(): Pool {
  if (pool) return pool;
  const url = tenantEnv().databaseUrl;
  if (url === null) {
    throw new DbError("there is no database on this host yet: DATABASE_URL is not set");
  }
  pool = new Pool({ connectionString: url, max: MAX_CONNECTIONS });
  return pool;
}

function clientDb(client: PoolClient): Db {
  return {
    async query<T extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await client.query(text, params as unknown[] | undefined);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

/** Runs one piece of work against one connection, and always gives the connection back. */
export async function withDb<T>(work: (db: Db) => Promise<T>): Promise<T> {
  if (provided) return await work(provided);
  const client = await poolOf().connect();
  try {
    return await work(clientDb(client));
  } finally {
    client.release();
  }
}

/**
 * Runs work inside one transaction, so a half written connection or plan never survives.
 *
 * Every write in this layer touches two tables, the row itself and the audit line beside
 * it, and a record with no audit line is worse than no record at all.
 */
export async function inTransaction<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    const result = await work();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

/** Closes the pool. A long lived process calls this on shutdown; a page never does. */
export async function closeDb(): Promise<void> {
  const open = pool;
  pool = null;
  if (open) await open.end();
}
