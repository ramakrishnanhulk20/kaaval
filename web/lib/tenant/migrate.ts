import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db";

/**
 * Numbered SQL files, applied in order, each one recorded so it is applied once.
 *
 * There is no rollback and there is no generated SQL: a migration is a file somebody
 * wrote and can read back, which is the only way to know what shape a live database is
 * in. The applied list is returned rather than printed, so the script and the tests can
 * both say what happened in their own words.
 */

const LEDGER_TABLE = `
  create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  )
`;

export interface Migration {
  id: string;
  sql: string;
}

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");
}

export function readMigrations(dir: string = migrationsDir()): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ id: name.replace(/\.sql$/, ""), sql: readFileSync(join(dir, name), "utf8") }));
}

/** Applies every migration that has not run yet. Returns the ids it applied, in order. */
export async function migrate(db: Db, migrations: Migration[] = readMigrations()): Promise<string[]> {
  await db.exec(LEDGER_TABLE);
  const { rows } = await db.query<{ id: string }>("select id from schema_migrations");
  const done = new Set(rows.map((row) => row.id));

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    await db.exec(migration.sql);
    await db.query("insert into schema_migrations (id) values ($1)", [migration.id]);
    applied.push(migration.id);
  }
  return applied;
}
