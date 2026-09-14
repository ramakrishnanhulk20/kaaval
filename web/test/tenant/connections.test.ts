import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { checkConnection } from "../../../src/tenant/credentials";
import { open, type Sealed } from "../../../src/tenant/seal";
import { upsertUser } from "../../lib/tenant/auth";
import { connect, listConnections, removeConnection } from "../../lib/tenant/connections";
import { freshDatabase, TEST_SEAL_KEY, type Harness } from "./harness";

// Storing a trader's exchange key: what is written, what is refused, and what comes back out.
// It does not cover the read against Bitget itself, which has its own tests beside the engine:
// the check is replaced here so the two answers it can give are both exercised in one run.

const USER = "did:privy:trader-one";

const GOOD = {
  label: "my main account",
  apiKey: "bg-api-key-000001",
  secretKey: "bg-secret-key-000001",
  passphrase: "bg-passphrase-1",
};

const accepted: typeof checkConnection = async () => ({
  ok: true,
  uid: "8812345",
  equityUsdt: 4210.25,
  positions: 2,
  checkedAt: Date.UTC(2026, 8, 14, 2, 0, 0),
});

const refused: typeof checkConnection = async () => ({
  ok: false,
  reason: "The secret key or the passphrase does not match that API key.",
  retryable: false,
});

describe("connections", () => {
  let harness: Harness;

  beforeEach(async () => {
    process.env.KAAVAL_KEY_SEAL_HEX = TEST_SEAL_KEY;
    harness = await freshDatabase();
    await upsertUser(harness.db, USER);
  });

  afterEach(async () => {
    await harness.close();
    delete process.env.KAAVAL_KEY_SEAL_HEX;
  });

  it("stores the key sealed, with what the read saw, and an audit line", async () => {
    const result = await connect(USER, GOOD, { check: accepted });
    expect(result.ok).toBe(true);

    const { rows } = await harness.db.query<{
      sealed: Sealed | string;
      uid: string;
      equity_usdt: string;
      positions: number;
      status: string;
    }>("select sealed, uid, equity_usdt, positions, status from connections");
    expect(rows).toHaveLength(1);

    const row = rows[0];
    if (row === undefined) throw new Error("no connection row");
    expect(row.uid).toBe("8812345");
    expect(Number(row.equity_usdt)).toBeCloseTo(4210.25, 2);
    expect(row.positions).toBe(2);
    expect(row.status).toBe("ok");

    const sealed = (typeof row.sealed === "string" ? JSON.parse(row.sealed) : row.sealed) as Sealed;
    expect(JSON.stringify(sealed)).not.toContain(GOOD.secretKey);
    expect(JSON.parse(open(sealed, TEST_SEAL_KEY))).toEqual({
      apiKey: GOOD.apiKey,
      secretKey: GOOD.secretKey,
      passphrase: GOOD.passphrase,
    });

    const audits = await harness.db.query<{ kind: string }>("select kind from audit");
    expect(audits.rows.map((entry) => entry.kind)).toEqual(["connection.created"]);
  });

  it("writes nothing when the exchange refuses the key, and says why", async () => {
    const result = await connect(USER, GOOD, { check: refused });

    expect(result).toEqual({
      ok: false,
      reason: "The secret key or the passphrase does not match that API key.",
      retryable: false,
    });

    const { rows } = await harness.db.query("select id from connections");
    expect(rows).toHaveLength(0);
  });

  it("refuses details that are the wrong shape before it touches the exchange", async () => {
    const result = await connect(USER, { ...GOOD, passphrase: "short" }, { check: accepted });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("that should have been refused");
    expect(result.reason).toMatch(/passphrase is too short/);

    const { rows } = await harness.db.query("select id from connections");
    expect(rows).toHaveLength(0);
  });

  it("keeps one row when the same Bitget account is connected twice, with the newer reading", async () => {
    const first = await connect(USER, GOOD, { check: accepted });
    if (!first.ok) throw new Error("the key should have been stored");

    const later: typeof checkConnection = async () => ({
      ok: true,
      uid: "8812345",
      equityUsdt: 5000.5,
      positions: 4,
      checkedAt: Date.UTC(2026, 8, 15, 2, 0, 0),
    });
    const second = await connect(USER, { ...GOOD, label: "renamed" }, { check: later });
    if (!second.ok) throw new Error("the second connect should have been stored");
    expect(second.connectionId).toBe(first.connectionId);

    const { rows } = await harness.db.query<{
      label: string;
      equity_usdt: string;
      positions: number;
      checked_at: Date | string;
    }>("select label, equity_usdt, positions, checked_at from connections");
    expect(rows).toHaveLength(1);

    const row = rows[0];
    if (row === undefined) throw new Error("no connection row");
    expect(row.label).toBe("renamed");
    expect(Number(row.equity_usdt)).toBeCloseTo(5000.5, 2);
    expect(row.positions).toBe(4);
    expect(new Date(row.checked_at).toISOString()).toBe(new Date(Date.UTC(2026, 8, 15, 2, 0, 0)).toISOString());

    const audits = await harness.db.query<{ kind: string }>("select kind from audit order by id");
    expect(audits.rows.map((entry) => entry.kind)).toEqual(["connection.created", "connection.updated"]);
  });

  it("lists a trader's keys without the sealed value in them", async () => {
    await connect(USER, GOOD, { check: accepted });
    await upsertUser(harness.db, "did:privy:someone-else");
    await connect("did:privy:someone-else", { ...GOOD, label: "their key" }, { check: accepted });

    const list = await listConnections(USER);
    expect(list).toHaveLength(1);
    const first = list[0];
    if (first === undefined) throw new Error("no connection listed");
    expect(first.label).toBe(GOOD.label);
    expect(JSON.stringify(list)).not.toContain(GOOD.secretKey);
    expect(Object.keys(first)).not.toContain("sealed");
  });

  it("removes only this trader's key, and logs the removal", async () => {
    const created = await connect(USER, GOOD, { check: accepted });
    if (!created.ok) throw new Error("the key should have been stored");

    expect(await removeConnection("did:privy:trader-two", created.connectionId)).toBe(false);
    expect(await removeConnection(USER, created.connectionId)).toBe(true);
    expect(await listConnections(USER)).toHaveLength(0);

    const audits = await harness.db.query<{ kind: string }>("select kind from audit order by id");
    expect(audits.rows.map((entry) => entry.kind)).toEqual(["connection.created", "connection.removed"]);
  });
});
