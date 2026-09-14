import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicKeyFromHex } from "../../../src/ledger/keys";
import { canonicalJson } from "../../../src/sim/book";
import type { checkConnection } from "../../../src/tenant/credentials";
import type { Plan } from "../../../src/tenant/plan";
import { upsertUser } from "../../lib/tenant/auth";
import { connect } from "../../lib/tenant/connections";
import { getPlan, planPublicKeyHex, planTonight, type PlanRunner } from "../../lib/tenant/plans";
import { freshDatabase, TEST_SEAL_KEY, type Harness } from "./harness";

// Making, storing and signing a plan, and the two limits around it. It does not cover the plan
// itself: what the brains decide and what the rulebook allows are proven in the engine's own
// tests, so the runner is replaced here with one that returns a fixed plan in a millisecond.

const USER = "did:privy:trader-one";

const CREDENTIALS = {
  label: "my main account",
  apiKey: "bg-api-key-000001",
  secretKey: "bg-secret-key-000001",
  passphrase: "bg-passphrase-1",
};

const acceptedAs = (uid: string): typeof checkConnection => async () => ({
  ok: true,
  uid,
  equityUsdt: 4210.25,
  positions: 0,
  checkedAt: Date.UTC(2026, 8, 14, 2, 0, 0),
});

function fixedPlan(accountId: string): Plan {
  return {
    id: `plan-${accountId}-1789000000000`,
    accountId,
    ts: 1789000000000,
    window: "normal",
    universe: ["SPOT:RTSLAUSDT"],
    before: {
      id: accountId,
      equity: 4210.25,
      balanceUsdt: 4210.25,
      realisedPnl: 0,
      unrealised: 0,
      drawdownPct: 0,
      dayPnlPct: 0,
      positions: [],
    },
    brains: [],
    rulebookHash: "a".repeat(64),
    ledgerSeqRange: null,
  };
}

const runner: PlanRunner = async (_credentials, accountId) => fixedPlan(accountId);

// A trader gets one row per Bitget account, so a test that wants several connections has to
// name a different account on each one.
async function connectOne(label: string, uid = "8812345"): Promise<string> {
  const created = await connect(USER, { ...CREDENTIALS, label }, { check: acceptedAs(uid) });
  if (!created.ok) throw new Error(`the key should have been stored: ${created.reason}`);
  return created.connectionId;
}

describe("planning tonight", () => {
  let harness: Harness;

  beforeEach(async () => {
    process.env.KAAVAL_KEY_SEAL_HEX = TEST_SEAL_KEY;
    const pair = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    process.env.KAAVAL_PLAN_KEY_PEM = pair.privateKey;

    harness = await freshDatabase();
    await upsertUser(harness.db, USER);
  });

  afterEach(async () => {
    await harness.close();
    delete process.env.KAAVAL_KEY_SEAL_HEX;
    delete process.env.KAAVAL_PLAN_KEY_PEM;
  });

  it("stores one plan and gives back the same one for five minutes", async () => {
    const connectionId = await connectOne("first");

    const first = await planTonight(USER, connectionId, { run: runner });
    const second = await planTonight(USER, connectionId, { run: runner });

    if (!first.ok || !second.ok) throw new Error("both plans should have been made");
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.planId).toBe(first.planId);

    const { rows } = await harness.db.query("select id from plans");
    expect(rows).toHaveLength(1);
  });

  it("signs the plan with a key anybody can check it against", async () => {
    const connectionId = await connectOne("first");
    const made = await planTonight(USER, connectionId, { run: runner });
    if (!made.ok) throw new Error("the plan should have been made");

    const stored = await getPlan(USER, made.planId);
    if (stored === null) throw new Error("the plan should have been readable");
    expect(stored.signature).not.toBeNull();

    const publicKeyHex = planPublicKeyHex();
    if (publicKeyHex === null || stored.signature === null) throw new Error("the plan should be signed");

    const holds = verify(
      null,
      Buffer.from(canonicalJson(stored.plan), "utf8"),
      publicKeyFromHex(publicKeyHex),
      Buffer.from(stored.signature, "hex"),
    );
    expect(holds).toBe(true);

    const edited = { ...stored.plan, rulebookHash: "b".repeat(64) };
    const stillHolds = verify(
      null,
      Buffer.from(canonicalJson(edited), "utf8"),
      publicKeyFromHex(publicKeyHex),
      Buffer.from(stored.signature, "hex"),
    );
    expect(stillHolds).toBe(false);
  });

  it("leaves the plan unsigned, and says so, when the host has no signing key", async () => {
    delete process.env.KAAVAL_PLAN_KEY_PEM;
    const connectionId = await connectOne("first");
    const made = await planTonight(USER, connectionId, { run: runner });
    if (!made.ok) throw new Error("the plan should have been made");

    const stored = await getPlan(USER, made.planId);
    expect(stored?.signature).toBeNull();
    expect(stored?.signed).toBe(false);
  });

  it("stops at six plans an hour and says when the next one is free", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      ids.push(await connectOne(`key ${String(index)}`, `881234${String(index)}`));
    }

    for (let index = 0; index < 6; index += 1) {
      const made = await planTonight(USER, ids[index] as string, { run: runner });
      expect(made.ok).toBe(true);
    }

    const refusedPlan = await planTonight(USER, ids[6] as string, { run: runner });
    expect(refusedPlan.ok).toBe(false);
    if (refusedPlan.ok) throw new Error("the seventh plan should have been refused");
    expect(refusedPlan.reason).toMatch(/6 plans in an hour/);
    expect(refusedPlan.reason).toMatch(/minutes/);
    expect(refusedPlan.retryAfterMs).toBeGreaterThan(0);

    const { rows } = await harness.db.query("select id from plans");
    expect(rows).toHaveLength(6);
  });

  it("refuses a connection that is not this trader's", async () => {
    const connectionId = await connectOne("first");
    await upsertUser(harness.db, "did:privy:trader-two");

    const made = await planTonight("did:privy:trader-two", connectionId, { run: runner });
    expect(made.ok).toBe(false);
    if (made.ok) throw new Error("that plan should have been refused");
    expect(made.reason).toMatch(/not on this account/);
  });
});
