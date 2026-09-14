import { PGlite } from "@electric-sql/pglite";
import { setDatabase, type Db } from "../../lib/tenant/db";
import { migrate } from "../../lib/tenant/migrate";

/**
 * A real Postgres for a test, in memory, with the real migrations applied.
 *
 * It is the same SQL the hosted database gets. Nothing here stubs a query or fakes a
 * row, so a column name that is wrong fails the test the way it would fail a trader.
 */
export interface Harness {
  db: Db;
  close: () => Promise<void>;
}

export async function freshDatabase(): Promise<Harness> {
  const pg = new PGlite();
  const db: Db = {
    async query<T extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await pg.query<T>(text, params as unknown[] | undefined);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };

  await migrate(db);
  setDatabase(db);

  return {
    db,
    close: async () => {
      setDatabase(null);
      await pg.close();
    },
  };
}

/** A signing key for the sealed credentials, made here so no test needs a real one. */
export const TEST_SEAL_KEY = "1".repeat(64);
