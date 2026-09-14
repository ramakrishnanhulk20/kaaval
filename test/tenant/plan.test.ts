// Tonight's plan for a real account: the world, the trader's own positions, every
// brain's targets, the rulebook's verdicts with the rule that refused each one, the
// Agent Hub dry runs, the shadow fills, and the signed ledger they are written to. The
// hard one is the last test: no write tool is ever invoked. Does NOT cover a live Bitget
// account or a real model call (the brains have their own tests), the sign-in that will
// hand this a key, or the fill model itself (sim/fill.test.ts).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountView, Brain, CalendarEvent, Decision, NewsItem, Target, WorldState } from "../../src/brain/types.js";
import { perceive } from "../../src/engine/perception.js";
import { buildUniverse, type Universe } from "../../src/engine/universe.js";
import { loadOrCreateKeyPair } from "../../src/ledger/keys.js";
import { Ledger, readEntries, verifyLedger } from "../../src/ledger/ledger.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import { planForAccount, type Plan, type PlanDeps } from "../../src/tenant/plan.js";
import { bookAround, fakeMarket } from "../support/fake-bitget.js";
import { fakeTenant, writeCalls, type FakeTenant, type FakeTenantSpec } from "./fake-tenant.js";

/** A Wednesday night in New York, the hours Kaaval exists for. */
const NOW = new Date("2026-09-11T02:00:00Z");

const quotes = {
  RTSLAUSDT: { last: 404, bid: 403.9, ask: 404.1, usdtVolume: 50_000_000 },
  TSLAUSDT: { last: 402, bid: 401.9, ask: 402.1, usdtVolume: 20_000_000 },
  SPYUSDT: { last: 660, bid: 659.9, ask: 660.1, usdtVolume: 5_000_000 },
  BTCUSDT: { last: 60_000, bid: 59_990, ask: 60_010, usdtVolume: 900_000_000 },
  ETHUSDT: { last: 3_000, bid: 2_999, ask: 3_001, usdtVolume: 400_000_000 },
};

const books = {
  RTSLAUSDT: bookAround(404, 50),
  TSLAUSDT: bookAround(402, 50),
  SPYUSDT: bookAround(660, 50),
  BTCUSDT: bookAround(60_000, 5),
  ETHUSDT: bookAround(3_000, 20),
};

/**
 * Four targets, one of each kind the rulebook has an answer for: a reduction that
 * passes, a size that gets cut to the order cap, a symbol nobody listed, and an order
 * too small to be worth sending.
 */
class FakeBrain implements Brain {
  readonly name = "fake";

  constructor(private readonly targets: Target[]) {}

  async decide(world: WorldState, _account: AccountView): Promise<Decision> {
    return {
      brain: this.name,
      ts: world.ts,
      targets: this.targets,
      summary: "a plan for the night",
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 1,
    };
  }
}

class BrokenBrain implements Brain {
  readonly name = "broken";

  async decide(): Promise<Decision> {
    throw new Error("the model refused to answer");
  }
}

function target(over: Partial<Target> & Pick<Target, "category" | "symbol" | "targetNotionalUsdt">): Target {
  return { hedgeFor: null, rationale: "test", confidence: 0.6, horizonMinutes: 60, ...over };
}

const TARGETS: Target[] = [
  target({ category: "SPOT", symbol: "RTSLAUSDT", targetNotionalUsdt: 1_000 }),
  target({ category: "USDT-FUTURES", symbol: "ETHUSDT", targetNotionalUsdt: 5_000 }),
  target({ category: "SPOT", symbol: "FAKEUSDT", targetNotionalUsdt: 500 }),
  target({ category: "USDT-FUTURES", symbol: "BTCUSDT", targetNotionalUsdt: 50 }),
];

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function universeAndPerception(): Promise<{ universe: Universe; perception: PlanDeps["perception"] }> {
  const market = fakeMarket({ quotes, books, tradedOverWeekend: ["RTSLAUSDT"], candleClose: 400 });
  const universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
    maxSymbols: 1,
    cacheFile: join(temp("kaaval-plan-uni-"), "universe.json"),
    ttlMs: 60_000,
    now: NOW,
  });
  return {
    universe,
    perception: {
      bitget: market,
      cacheDir: temp("kaaval-plan-news-"),
      log: () => {},
      news: async (): Promise<NewsItem[]> => [],
      calendar: async (): Promise<CalendarEvent[]> => [],
    },
  };
}

interface Run {
  plan: Plan;
  tenant: FakeTenant;
  ledgerDir: string;
  publicKeyHex: string;
}

async function run(opts: { brains?: Brain[]; tenant?: FakeTenantSpec; withLedger?: boolean } = {}): Promise<Run> {
  const { universe, perception } = await universeAndPerception();
  const tenant = fakeTenant(opts.tenant ?? {});
  const ledgerDir = temp("kaaval-plan-ledger-");
  const keys = loadOrCreateKeyPair(join(temp("kaaval-plan-key-"), "ledger-key.pem"));
  const ledger = opts.withLedger === false ? null : new Ledger(ledgerDir, keys);

  const deps: PlanDeps = {
    perception,
    universe,
    brains: opts.brains ?? [new FakeBrain(TARGETS)],
    rulebook: DEFAULT_RULEBOOK,
    ctx: tenant,
    ledger,
    startOfDayEquity: null,
    peakEquity: null,
    now: NOW,
  };
  return { plan: await planForAccount(deps, "tenant-1"), tenant, ledgerDir, publicKeyHex: keys.publicKeyHex };
}

describe("planForAccount", () => {
  it("plans against the trader's own account, not a paper one", async () => {
    const { plan } = await run();
    expect(plan.accountId).toBe("tenant-1");
    expect(plan.ts).toBe(NOW.getTime());
    expect(plan.before.equity).toBeCloseTo(7246.44, 2);
    expect(plan.before.positions.map((p) => p.symbol).sort()).toEqual(["RTSLAUSDT", "TSLAUSDT"]);
    expect(plan.universe).toContain("SPOT:RTSLAUSDT");
    expect(plan.rulebookHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the rule behind every refusal", async () => {
    const { plan } = await run();
    const refused = plan.brains[0]?.verdicts.filter((v) => !v.allowed) ?? [];
    const byRule = new Map(refused.map((v) => [v.allowed ? "" : v.rule, v]));

    const notListed = byRule.get("universe.symbol");
    expect(notListed).toBeDefined();
    if (notListed && !notListed.allowed) {
      expect(notListed.intent.symbol).toBe("FAKEUSDT");
      expect(notListed.reason).toContain("not in today's universe");
    }

    const tooSmall = byRule.get("exposure.minOrderUsdt");
    expect(tooSmall).toBeDefined();
    if (tooSmall && !tooSmall.allowed) {
      expect(tooSmall.intent.symbol).toBe("BTCUSDT");
      expect(tooSmall.reason).toContain("minimum order");
    }
  });

  it("cuts an oversized order to the cap and says so, rather than refusing it", async () => {
    const { plan } = await run();
    const eth = plan.brains[0]?.verdicts.find((v) => v.intent.symbol === "ETHUSDT");
    expect(eth?.allowed).toBe(true);
    if (!eth?.allowed) return;
    expect(eth.intent.notionalUsdt).toBe(DEFAULT_RULEBOOK.exposure.maxOrderUsdt);
    expect(eth.notes.join(" ")).toContain("exposure.maxOrderUsdt");
  });

  it("asks for the hedge the rulebook demands on the account's own rToken", async () => {
    const { plan } = await run();
    const hedge = plan.brains[0]?.verdicts.find((v) => v.intent.hedgeFor === "RTSLAUSDT");
    expect(hedge).toBeDefined();
    expect(hedge?.intent.symbol).toBe("TSLAUSDT");
    expect(hedge?.intent.side).toBe("sell");
  });

  it("records the Agent Hub request and a shadow fill for every order it would send", async () => {
    const { plan } = await run();
    const orders = plan.brains[0]?.orders ?? [];
    expect(orders.length).toBeGreaterThan(0);

    for (const order of orders) {
      expect(order.dryRun["dryRun"]).toBe(true);
      expect(order.dryRun["operationId"]).toBe("placeOrder");
      const sent = order.dryRun["wouldSend"] as Record<string, unknown>;
      expect(sent["symbol"]).toBe(order.intent.symbol);
      expect(sent["side"]).toBe(order.intent.side);
      expect(order.bookHash).toMatch(/^[0-9a-f]{64}$/);
      expect(order.shadowFill).not.toBeNull();
    }

    const sell = orders.find((o) => o.intent.symbol === "RTSLAUSDT");
    expect(sell?.shadowFill && "qty" in sell.shadowFill ? sell.shadowFill.qty : 0).toBeGreaterThan(0);
  });

  it("marks the account as it would stand if every one of those orders had filled", async () => {
    const { plan } = await run();
    const mark = plan.brains[0]?.shadowMark;
    expect(mark).toBeDefined();
    if (!mark) return;
    expect(Number.isFinite(mark.equityAfter)).toBe(true);
    // Fees are realised the moment they are paid, so a plan that trades costs something.
    expect(mark.realised).toBeLessThan(0);
    expect(Math.abs(mark.equityAfter - plan.before.equity)).toBeLessThan(plan.before.equity);
  });

  it("never invokes a write tool, not once, for any brain", async () => {
    const { plan, tenant } = await run({ brains: [new FakeBrain(TARGETS), new FakeBrain(TARGETS)] });
    expect(plan.brains).toHaveLength(2);
    expect(writeCalls(tenant)).toEqual([]);

    const tools = new Set(tenant.calls.map((call) => call.tool));
    expect([...tools].sort()).toEqual(["account_overview", "order"]);
    for (const call of tenant.calls) {
      if (call.tool !== "order") continue;
      expect(call.args["action"]).toBe("place");
      expect(call.args["dryRun"]).toBe(true);
    }
    // The account is read once for the plan, not once per brain.
    expect(tenant.calls.filter((call) => call.tool === "account_overview")).toHaveLength(1);
  });

  it("never sells more of a holding than the account owns", async () => {
    // Closing 2020 USDT of rTSLA at the bid rounds to a hair more than the five tokens
    // held. An order for more than the position is one Bitget would bounce.
    const flatten = [target({ category: "SPOT", symbol: "RTSLAUSDT", targetNotionalUsdt: 0 })];
    const { plan } = await run({ brains: [new FakeBrain(flatten)] });
    const order = plan.brains[0]?.orders.find((o) => o.intent.symbol === "RTSLAUSDT");
    expect(order).toBeDefined();
    expect(Number(order?.dryRun["wouldSend"] && (order.dryRun["wouldSend"] as Record<string, unknown>)["qty"])).toBe(5);
    expect(order?.shadowFill && "qty" in order.shadowFill ? order.shadowFill.qty : 0).toBe(5);
  });

  it("records a brain that failed and still plans the next one", async () => {
    const { plan } = await run({ brains: [new BrokenBrain(), new FakeBrain(TARGETS)] });
    const broken = plan.brains[0];
    expect(broken?.decision).toBeNull();
    expect(broken?.error).toContain("refused to answer");
    expect(broken?.orders).toEqual([]);
    expect(plan.brains[1]?.orders.length).toBeGreaterThan(0);
  });

  it("writes a chain the verifier accepts, and says which entries are its own", async () => {
    const { plan, ledgerDir, publicKeyHex } = await run();
    const range = plan.ledgerSeqRange;
    expect(range).not.toBeNull();
    if (!range) return;

    const verified = verifyLedger(ledgerDir, publicKeyHex);
    expect(verified.ok).toBe(true);
    expect(verified.firstBad).toBeNull();

    const entries = readEntries(ledgerDir);
    expect(entries).toHaveLength(verified.entries);
    expect(entries[0]?.seq).toBe(range[0]);
    expect(entries.at(-1)?.seq).toBe(range[1]);
    for (const entry of entries) {
      expect(entry.account).toBe("tenant-1");
      expect((entry.payload as { plan?: string }).plan).toBe(plan.id);
    }
    const kinds = new Set(entries.map((entry) => entry.kind));
    expect(kinds).toContain("decision");
    expect(kinds).toContain("reject");
    expect(kinds).toContain("order");
    expect(kinds).toContain("mark");
  });

  it("plans without a ledger at all, for a caller that only wants to show it", async () => {
    const { plan } = await run({ withLedger: false });
    expect(plan.ledgerSeqRange).toBeNull();
    expect(plan.brains[0]?.orders.length).toBeGreaterThan(0);
  });
});
