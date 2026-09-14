import type { Db } from "../lib/tenant/db";
import { withDb } from "../lib/tenant/db";
import { migrate, readMigrations } from "../lib/tenant/migrate";

/**
 * Brings a database up to the current shape, and says what it did.
 *
 * With DATABASE_URL set it migrates that database. With nothing set it migrates an
 * embedded Postgres that lives in memory for the length of this command, which proves
 * the files apply cleanly on a machine that has no database yet. The second mode is why
 * this command is safe to run before anybody has signed up for anything.
 */

async function memoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  return {
    async query<T extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await pg.query<T>(text, params as unknown[] | undefined);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
}

async function main(): Promise<void> {
  // Neon hands out two strings for the same database: a pooled one for the app and a direct
  // one for the server itself. Schema changes have to go down the direct string, because the
  // pooler hands each statement whatever session it likes and a CREATE INDEX can land on a
  // connection that is not the one that started the work.
  const direct = process.env.DATABASE_URL_DIRECT;
  const url = direct ?? process.env.DATABASE_URL;
  const live = url !== undefined && url.trim() !== "";
  // The pool below this script reads DATABASE_URL and nothing else, so the direct string
  // takes that name for the length of this command.
  if (live && direct !== undefined) process.env.DATABASE_URL = direct;
  const files = readMigrations();
  console.log(`${String(files.length)} migration files found: ${files.map((file) => file.id).join(", ")}`);

  const applied = live ? await withDb((db) => migrate(db, files)) : await migrate(await memoryDb(), files);

  const named = direct === undefined ? "DATABASE_URL" : "DATABASE_URL_DIRECT";
  console.log(live ? `target: the database in ${named}` : "target: an embedded Postgres in memory, nothing is kept");
  if (applied.length === 0) console.log("applied: nothing, every migration was already in place");
  else console.log(`applied: ${applied.join(", ")}`);
}

main().then(
  async () => {
    const { closeDb } = await import("../lib/tenant/db");
    await closeDb();
    process.exit(0);
  },
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
