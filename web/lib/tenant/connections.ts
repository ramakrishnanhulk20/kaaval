import { z } from "zod";
import { checkConnection, type BitgetCredentials, type ConnectionCheck } from "../../../src/tenant/credentials";
import { open, seal, type Sealed } from "../../../src/tenant/seal";
import { inTransaction, withDb, type Db } from "./db";
import { tenantEnv } from "./env";

/**
 * A trader's exchange key: checked with one read, sealed, stored, and never handed back.
 *
 * Nothing in this file returns the sealed value or any part of a credential to a caller.
 * The only way the three strings come back out is openCredentials, which is called on the
 * server for the seconds a plan runs and by nothing else.
 */

export interface ConnectInput {
  label: string;
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface ConnectionRow {
  id: string;
  label: string;
  uid: string | null;
  equityUsdt: number | null;
  positions: number | null;
  checkedAt: string | null;
  status: string;
  createdAt: string;
}

export type ConnectResult =
  | { ok: true; connectionId: string; uid: string | null; equityUsdt: number; positions: number }
  | { ok: false; reason: string; retryable: boolean };

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** What a trader may send. Anything outside this never reaches Bitget or the database. */
const inputSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "give this key a label so you can tell it from the next one")
    .max(40, "that label is longer than 40 characters"),
  apiKey: z
    .string()
    .trim()
    .min(8, "that API key is too short to be a Bitget key")
    .max(128, "that API key is longer than any Bitget key"),
  secretKey: z
    .string()
    .trim()
    .min(8, "that secret key is too short to be a Bitget secret")
    .max(128, "that secret key is longer than any Bitget secret"),
  passphrase: z
    .string()
    .trim()
    .min(8, "that passphrase is too short to be the one on the key")
    .max(128, "that passphrase is longer than any Bitget passphrase"),
});

const idSchema = z.uuid("that is not a connection id");

/** The three strings under one seal, so a row opens whole or not at all. */
interface SealedCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface ConnectDeps {
  check?: typeof checkConnection;
}

/**
 * Checks a key with one read and stores it only if the exchange answered.
 *
 * The order matters: nothing is written until the read has come back, so a wrong
 * passphrase leaves no row behind and the trader gets the reason in a sentence. The write
 * itself is one transaction, the connection row and its audit line together.
 *
 * Connecting the same Bitget account twice updates the row that is already there rather
 * than leaving a second copy of the same sealed key behind. A key Bitget answered without
 * naming a uid cannot be proved to be the same account, so it is stored as its own row.
 */
export async function connect(userId: string, input: ConnectInput, deps: ConnectDeps = {}): Promise<ConnectResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "those details cannot be read", retryable: false };
  }

  const sealKey = tenantEnv().sealKeyHex;
  if (sealKey === null) {
    return {
      ok: false,
      reason: "this host cannot store a key yet: the sealing key is not set on the server",
      retryable: false,
    };
  }

  const creds: BitgetCredentials = {
    apiKey: parsed.data.apiKey,
    secretKey: parsed.data.secretKey,
    passphrase: parsed.data.passphrase,
  };

  const run = deps.check ?? checkConnection;
  const result: ConnectionCheck = await run(creds);
  if (!result.ok) {
    console.warn(`a key was refused for a signed-in trader: ${result.reason}`);
    return { ok: false, reason: result.reason, retryable: result.retryable };
  }

  const sealed = seal(JSON.stringify(creds), sealKey);

  return await withDb(async (db) =>
    inTransaction(db, async () => {
      // xmax is zero on a row this statement inserted and non-zero on one it updated, which
      // is how the audit line below can say which of the two happened.
      const { rows } = await db.query<{ id: string; inserted: boolean }>(
        [
          "insert into connections (user_id, label, uid, sealed, equity_usdt, positions, checked_at, status)",
          "values ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), $8)",
          "on conflict (user_id, uid) do update set",
          "label = excluded.label, sealed = excluded.sealed, equity_usdt = excluded.equity_usdt,",
          "positions = excluded.positions, checked_at = excluded.checked_at, status = excluded.status",
          "returning id, (xmax = 0) as inserted",
        ].join(" "),
        [
          userId,
          parsed.data.label,
          result.uid,
          JSON.stringify(sealed),
          result.equityUsdt,
          result.positions,
          result.checkedAt,
          "ok",
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new ConnectionError("the database accepted no connection row");
      const id = row.id;

      await audit(db, userId, row.inserted ? "connection.created" : "connection.updated", {
        connection: id,
        uid: result.uid,
        positions: result.positions,
      });

      return {
        ok: true as const,
        connectionId: id,
        uid: result.uid,
        equityUsdt: result.equityUsdt,
        positions: result.positions,
      };
    }),
  );
}

/**
 * Every key this trader has connected, newest first.
 *
 * The columns are named one by one rather than taken with a star, so the sealed value
 * cannot reach a page later because somebody widened the table.
 */
export async function listConnections(userId: string): Promise<ConnectionRow[]> {
  return await withDb(async (db) => {
    const { rows } = await db.query<{
      id: string;
      label: string;
      uid: string | null;
      equity_usdt: string | number | null;
      positions: number | null;
      checked_at: Date | string | null;
      status: string;
      created_at: Date | string;
    }>(
      [
        "select id, label, uid, equity_usdt, positions, checked_at, status, created_at",
        "from connections where user_id = $1 order by created_at desc",
      ].join(" "),
      [userId],
    );

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      uid: row.uid,
      equityUsdt: row.equity_usdt === null ? null : Number(row.equity_usdt),
      positions: row.positions === null ? null : Number(row.positions),
      checkedAt: row.checked_at === null ? null : new Date(row.checked_at).toISOString(),
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  });
}

/**
 * Forgets a key and everything planned with it.
 *
 * The user id is part of the delete rather than checked before it, so there is no window
 * between the check and the write in which the row could belong to somebody else. Plans
 * go with it through the foreign key, which is what a trader means by remove.
 */
export async function removeConnection(userId: string, connectionId: string): Promise<boolean> {
  const id = idSchema.safeParse(connectionId);
  if (!id.success) return false;

  return await withDb(async (db) =>
    inTransaction(db, async () => {
      const { rows } = await db.query<{ id: string }>(
        "delete from connections where id = $1 and user_id = $2 returning id",
        [id.data, userId],
      );
      if (rows.length === 0) return false;
      await audit(db, userId, "connection.removed", { connection: id.data });
      return true;
    }),
  );
}

/**
 * Opens the three credential strings for one connection, on the server, for one job.
 *
 * It exists for the plan runner and nothing else. The strings never travel back through a
 * server action, are never logged, and are never put in an error message.
 */
export async function openCredentials(
  userId: string,
  connectionId: string,
): Promise<{ credentials: BitgetCredentials; uid: string | null } | null> {
  const id = idSchema.safeParse(connectionId);
  if (!id.success) return null;
  const sealKey = tenantEnv().sealKeyHex;
  if (sealKey === null) throw new ConnectionError("the sealing key is not set on the server");

  return await withDb(async (db) => {
    const { rows } = await db.query<{ sealed: Sealed | string; uid: string | null }>(
      "select sealed, uid from connections where id = $1 and user_id = $2",
      [id.data, userId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const sealed = (typeof row.sealed === "string" ? JSON.parse(row.sealed) : row.sealed) as Sealed;
    const opened = JSON.parse(open(sealed, sealKey)) as SealedCredentials;
    return { credentials: opened, uid: row.uid };
  });
}

/** One line in the log of what was done to this account, and by which action. */
export async function audit(db: Db, userId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  await db.query("insert into audit (user_id, kind, detail) values ($1, $2, $3)", [
    userId,
    kind,
    JSON.stringify(detail),
  ]);
}
