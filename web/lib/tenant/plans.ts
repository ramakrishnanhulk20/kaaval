import { createPrivateKey, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBrain } from "../../../src/brain/claude";
import { AnthropicClient } from "../../../src/brain/llm";
import { RulesBrain } from "../../../src/brain/rules";
import type { Brain } from "../../../src/brain/types";
import { createBitget } from "../../../src/bitget/client";
import type { PerceptionDeps } from "../../../src/engine/perception";
import { buildUniverse } from "../../../src/engine/universe";
import { publicKeyHexOf } from "../../../src/ledger/keys";
import { gatherCalendar, gatherNews } from "../../../src/news/feed";
import { DEFAULT_RULEBOOK } from "../../../src/risk/rulebook";
import { canonicalJson } from "../../../src/sim/book";
import type { BitgetCredentials } from "../../../src/tenant/credentials";
import { contextFor } from "../../../src/tenant/credentials";
import { planForAccount, type Plan } from "../../../src/tenant/plan";
import { audit, openCredentials } from "./connections";
import { inTransaction, withDb, type Db } from "./db";
import { tenantEnv } from "./env";

/**
 * Tonight's plan for one connected account: made on demand, signed, and stored.
 *
 * Three rules hold this together. A plan is expensive, so asking twice inside five
 * minutes gives back the plan that already exists instead of running again. A plan reads
 * a market and a model, so a trader gets six an hour and is told when they can have the
 * next one. And a plan is a claim about what Kaaval would have done, so it is signed with
 * the same kind of key the public record is signed with and can be checked by anybody.
 */

/** A plan takes about a minute. Two inside five minutes would be the same plan twice. */
const SAME_PLAN_MINUTES = 5;

/** Six an hour per signed-in trader, counted in the database against the verified user id. */
const PLANS_PER_HOUR = 6;

const HOUR_MS = 60 * 60 * 1000;

const UNIVERSE_TTL_MS = 24 * HOUR_MS;

/** A trader is waiting on this, so a brain gets a minute, not the three the engine allows. */
const DECISION_TIMEOUT_MS = 60_000;

const DEFAULT_MAX_SYMBOLS = 6;

/** The engine's own ensemble shape, with the run count turned down for a waiting trader. */
const ENSEMBLE = { shrink: 0.2, floorConfidence: 0.1, temperature: 0.7 };

export type PlanOutcome =
  | { ok: true; planId: string; reused: boolean }
  | { ok: false; reason: string; retryAfterMs: number | null };

export interface PlanRow {
  id: string;
  connectionId: string;
  label: string;
  ts: string;
  window: string;
  signed: boolean;
}

export interface StoredPlan extends PlanRow {
  plan: Plan;
  signature: string | null;
  publicKeyHex: string | null;
}

/** The one call a test replaces, so the whole path can be proven without a market. */
export type PlanRunner = (credentials: BitgetCredentials, accountId: string) => Promise<Plan>;

export interface PlanDepsOverride {
  run?: PlanRunner;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * Makes tonight's plan for one connection, or says plainly why not.
 *
 * The long work happens outside any transaction and outside any lock: a plan is a minute
 * of market reads and model calls, and holding a database connection open across it would
 * starve every other page. The five minute check is made again after the work, so two
 * requests that started together still end with one plan and both traders see it.
 */
export async function planTonight(
  userId: string,
  connectionId: string,
  deps: PlanDepsOverride = {},
): Promise<PlanOutcome> {
  const existing = await recentPlanId(userId, connectionId);
  if (existing !== null) return { ok: true, planId: existing, reused: true };

  const limit = await rateLimit(userId);
  if (limit !== null) return limit;

  const opened = await openCredentials(userId, connectionId);
  if (opened === null) {
    return { ok: false, reason: "that connection is not on this account any more", retryAfterMs: null };
  }

  const accountId = safeAccountId(opened.uid);
  const run = deps.run ?? defaultRunner;
  const plan = await run(opened.credentials, accountId);
  const signature = signPlan(plan);

  return await withDb(async (db) =>
    inTransaction(db, async () => {
      const again = await recentPlanIdIn(db, userId, connectionId);
      if (again !== null) return { ok: true as const, planId: again, reused: true };

      const { rows } = await db.query<{ id: string }>(
        [
          'insert into plans (connection_id, ts, "window", plan, signature)',
          "values ($1, to_timestamp($2 / 1000.0), $3, $4, $5) returning id",
        ].join(" "),
        [connectionId, plan.ts, plan.window, JSON.stringify(plan), signature],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new PlanError("the database accepted no plan row");

      await db.query(
        "update connections set equity_usdt = $1, positions = $2, checked_at = now(), status = $3 where id = $4 and user_id = $5",
        [plan.before.equity, plan.before.positions.length, "ok", connectionId, userId],
      );
      await audit(db, userId, "plan.created", { connection: connectionId, plan: id, signed: signature !== null });

      return { ok: true as const, planId: id, reused: false };
    }),
  );
}

/** Every plan made for this trader, newest first, with the connection it belongs to. */
export async function listPlans(userId: string, connectionId?: string): Promise<PlanRow[]> {
  return await withDb(async (db) => {
    const params: unknown[] = [userId];
    if (connectionId !== undefined) params.push(connectionId);
    const { rows } = await db.query<{
      id: string;
      connection_id: string;
      label: string;
      ts: Date | string;
      window: string;
      signature: string | null;
    }>(
      [
        'select p.id, p.connection_id, c.label, p.ts, p."window", p.signature',
        "from plans p join connections c on c.id = p.connection_id",
        "where c.user_id = $1",
        connectionId === undefined ? "" : "and p.connection_id = $2",
        "order by p.ts desc limit 50",
      ].join(" "),
      params,
    );
    return rows.map(toRow);
  });
}

/** One stored plan, with the signature and the key it can be checked against. */
export async function getPlan(userId: string, planId: string): Promise<StoredPlan | null> {
  return await withDb(async (db) => {
    const { rows } = await db.query<{
      id: string;
      connection_id: string;
      label: string;
      ts: Date | string;
      window: string;
      signature: string | null;
      plan: Plan | string;
    }>(
      [
        'select p.id, p.connection_id, c.label, p.ts, p."window", p.signature, p.plan',
        "from plans p join connections c on c.id = p.connection_id",
        "where p.id = $1 and c.user_id = $2",
      ].join(" "),
      [planId, userId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    return {
      ...toRow(row),
      plan: (typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan) as Plan,
      signature: row.signature,
      publicKeyHex: planPublicKeyHex(),
    };
  });
}

/** The public half of the plan signing key, or null on a host that has no key set. */
export function planPublicKeyHex(): string | null {
  const pem = tenantEnv().planKeyPem;
  if (pem === null) return null;
  try {
    return publicKeyHexOf(pem);
  } catch {
    return null;
  }
}

/**
 * Signs the canonical JSON of the plan, the same shape and the same kind of key the
 * public record uses, so a trader checks a plan the way a judge checks the ledger.
 */
function signPlan(plan: Plan): string | null {
  const pem = tenantEnv().planKeyPem;
  if (pem === null) return null;
  return sign(null, Buffer.from(canonicalJson(plan), "utf8"), createPrivateKey(pem)).toString("hex");
}

function toRow(row: {
  id: string;
  connection_id: string;
  label: string;
  ts: Date | string;
  window: string;
  signature: string | null;
}): PlanRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    label: row.label,
    ts: new Date(row.ts).toISOString(),
    window: row.window,
    signed: row.signature !== null,
  };
}

async function recentPlanId(userId: string, connectionId: string): Promise<string | null> {
  return await withDb((db) => recentPlanIdIn(db, userId, connectionId));
}

async function recentPlanIdIn(db: Db, userId: string, connectionId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    [
      "select p.id from plans p join connections c on c.id = p.connection_id",
      "where p.connection_id = $1 and c.user_id = $2",
      `and p.created_at > now() - interval '${String(SAME_PLAN_MINUTES)} minutes'`,
      "order by p.created_at desc limit 1",
    ].join(" "),
    [connectionId, userId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The hourly count, made against the verified user id rather than anything the caller
 * sends, so a second browser tab or a cleared cookie does not buy a fresh allowance.
 */
async function rateLimit(userId: string): Promise<PlanOutcome | null> {
  return await withDb(async (db) => {
    const { rows } = await db.query<{ made: string | number; oldest: Date | string | null }>(
      [
        "select count(*) as made, min(p.created_at) as oldest",
        "from plans p join connections c on c.id = p.connection_id",
        "where c.user_id = $1 and p.created_at > now() - interval '1 hour'",
      ].join(" "),
      [userId],
    );
    const made = Number(rows[0]?.made ?? 0);
    const oldest = rows[0]?.oldest ?? null;
    if (made < PLANS_PER_HOUR) return null;

    const freeAt = oldest === null ? Date.now() + HOUR_MS : new Date(oldest).getTime() + HOUR_MS;
    const waitMs = Math.max(0, freeAt - Date.now());
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    console.warn(`plan rate limit hit by a signed-in trader, ${String(made)} in the last hour`);
    return {
      ok: false,
      reason: `That is ${String(PLANS_PER_HOUR)} plans in an hour, which is the limit. The next one is free in about ${String(minutes)} minutes.`,
      retryAfterMs: waitMs,
    };
  });
}

/** A file name and a ledger name a shell can type. The uid comes from Bitget, so never trust it. */
function safeAccountId(uid: string | null): string {
  const cleaned = (uid ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned === "" ? "account" : cleaned;
}

/**
 * The real plan: the same deps the command line runner builds, with the caches in the
 * system temp folder because a hosted web server has no writable folder of its own.
 */
const defaultRunner: PlanRunner = async (credentials, accountId) => {
  const env = tenantEnv();

  // The engine reads this budget from the environment at the moment a brain is called.
  // It is set here only when a host has not set it, so a deploy can still choose.
  process.env.KAAVAL_DECISION_TIMEOUT_MS ??= String(DECISION_TIMEOUT_MS);

  const market = createBitget();
  const universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
    maxSymbols: maxSymbols(),
    cacheFile: join(tmpdir(), "kaaval-web", "universe.json"),
    ttlMs: UNIVERSE_TTL_MS,
  });

  const perception: PerceptionDeps = {
    bitget: market,
    news: gatherNews,
    calendar: gatherCalendar,
    cacheDir: join(tmpdir(), "kaaval-web", "news-cache"),
    log: () => {},
  };

  const brains: Brain[] = [new RulesBrain(DEFAULT_RULEBOOK)];
  if (env.anthropicKey !== null) {
    brains.push(new ClaudeBrain(new AnthropicClient(), { ...ENSEMBLE, runs: env.ensembleRuns }));
  }

  return await planForAccount(
    {
      perception,
      universe,
      brains,
      rulebook: DEFAULT_RULEBOOK,
      ctx: contextFor(credentials),
      // A trader's plan is not part of the public record, so it writes no ledger entries.
      ledger: null,
      startOfDayEquity: null,
      peakEquity: null,
    },
    accountId,
  );
};

function maxSymbols(): number {
  const raw = Number(process.env.KAAVAL_MAX_SYMBOLS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_SYMBOLS;
}
