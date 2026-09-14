// Sizing, the Agent Hub request, the fill against the recorded book, and the stops that
// follow. Does NOT cover the rulebook's own refusals (risk tests), the fill model itself
// (sim/fill.test.ts), or a real call to Bitget's demo environment: the demo path is
// exercised through a fake, because no demo key exists yet.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CalendarEvent, NewsItem } from "../../src/brain/types.js";
import { executeVerdicts, type ExecutionDeps } from "../../src/engine/execution.js";
import { perceive } from "../../src/engine/perception.js";
import { newBrainState, type BrainState } from "../../src/engine/state.js";
import { buildUniverse } from "../../src/engine/universe.js";
import { loadOrCreateKeyPair } from "../../src/ledger/keys.js";
import { Ledger, readEntries } from "../../src/ledger/ledger.js";
import type { OrderIntent, Verdict } from "../../src/risk/limits.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import { positionKey } from "../../src/sim/account.js";
import type { Category, FeeSchedule, SimOrder, SlippageModel } from "../../src/sim/types.js";
import { bookAround, fakeMarket, fakeOrderDesk, previewOf } from "../support/fake-bitget.js";

const NOW = new Date("2026-09-11T02:00:00Z");

const FEES: Record<Category, FeeSchedule> = {
  SPOT: { makerRate: 0.001, takerRate: 0.001 },
  "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 },
};

const MODEL: SlippageModel = { maxBookFraction: 0.25, extraBps: 5 };

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

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function perceived() {
  const ctx = fakeMarket({ quotes, books, tradedOverWeekend: ["RTSLAUSDT"], candleClose: 400 });
  const universe = await buildUniverse(ctx, DEFAULT_RULEBOOK, {
    maxSymbols: 1,
    cacheFile: join(temp("kaaval-exec-uni-"), "universe.json"),
    ttlMs: 60_000,
    now: NOW,
  });
  return await perceive(
    {
      bitget: ctx,
      cacheDir: temp("kaaval-exec-news-"),
      log: () => {},
      news: async (): Promise<NewsItem[]> => [],
      calendar: async (): Promise<CalendarEvent[]> => [],
    },
    universe,
    NOW,
    NOW.getTime() - 3_600_000,
  );
}

function ledgerIn(dir: string): Ledger {
  return new Ledger(dir, loadOrCreateKeyPair(join(temp("kaaval-exec-key-"), "ledger-key.pem")));
}

function deps(over: Partial<ExecutionDeps> = {}): { deps: ExecutionDeps; dir: string } {
  const dir = temp("kaaval-exec-ledger-");
  return {
    dir,
    deps: {
      bitget: fakeOrderDesk(previewOf) as never,
      demo: null,
      ledger: ledgerIn(dir),
      rulebook: DEFAULT_RULEBOOK,
      fees: FEES,
      model: MODEL,
      log: () => {},
      ...over,
    },
  };
}

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    category: "SPOT",
    symbol: "RTSLAUSDT",
    side: "buy",
    notionalUsdt: 400,
    reduceOnly: false,
    hedgeFor: null,
    brain: "rules",
    source: "brain",
    ...over,
  };
}

function allow(over: Partial<OrderIntent> = {}, notes: string[] = []): Verdict {
  return { allowed: true, intent: intent(over), clipped: notes.length > 0, notes };
}

function state(): BrainState {
  return newBrainState("rules", 10_000, NOW);
}

function kinds(dir: string): string[] {
  return readEntries(dir).map((entry) => entry.kind);
}

describe("executeVerdicts", () => {
  it("rests an rToken at the touch, rounded down to the instrument's precision", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    const done = await executeVerdicts(d, "rules", [allow()], seen, state(), NOW);

    const entries = readEntries(dir);
    const order = entries.find((e) => e.kind === "order")?.payload as { order: SimOrder; notes: string[] };
    expect(order.order.type).toBe("limit");
    expect(order.order.limitPrice).toBe(404.2);
    // 400 USDT at 404.2, floored to the four decimals Bitget lists for rTSLA.
    expect(order.order.qty).toBe(0.9896);
    expect(done.fills).toHaveLength(1);
    expect(done.fills[0]?.avgPrice).toBeCloseTo(404.2 * 1.0005, 9);
    expect(done.rows[0]?.instrument).toBe("RTSLAUSDT");
    expect(done.state.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.qty).toBe(0.9896);
    expect(done.state.account.balanceUsdt).toBeLessThan(10_000);
  });

  it("sends a perpetual hedge at market", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    await executeVerdicts(
      d,
      "rules",
      [allow({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "sell", notionalUsdt: 200, hedgeFor: "RTSLAUSDT" })],
      seen,
      state(),
      NOW,
    );

    const order = (readEntries(dir).find((e) => e.kind === "order")?.payload as { order: SimOrder }).order;
    expect(order.type).toBe("market");
    expect(order.limitPrice).toBeUndefined();
    expect(order.qty).toBe(0.49);
  });

  it("refuses an order under Bitget's own minimum and writes the reason", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    const done = await executeVerdicts(d, "rules", [allow({ notionalUsdt: 5 })], seen, state(), NOW);

    expect(done.fills).toHaveLength(0);
    expect(done.rejected[0]?.reason).toContain("minimum");
    expect(kinds(dir)).toEqual(["reject"]);
  });

  it("writes one snapshot per book per tick, before the fill that names it", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    await executeVerdicts(d, "rules", [allow(), allow({ notionalUsdt: 300 })], seen, state(), NOW);

    const entries = readEntries(dir);
    const order = entries.map((e) => e.kind);
    expect(order.filter((kind) => kind === "snapshot")).toHaveLength(1);
    expect(order.indexOf("snapshot")).toBeLessThan(order.indexOf("fill"));
    const hashes = new Set(entries.filter((e) => e.kind === "fill").map((e) => (e.payload as { fill: { bookHash: string } }).fill.bookHash));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe((entries.find((e) => e.kind === "snapshot")?.payload as { bookHash: string }).bookHash);
  });

  it("records the SDK's own dry-run request beside the order", async () => {
    const seen = await perceived();
    const desk = fakeOrderDesk(previewOf);
    const { deps: d, dir } = deps({ bitget: desk as never });

    await executeVerdicts(d, "rules", [allow()], seen, state(), NOW);

    expect(desk.calls[0]?.args["action"]).toBe("place");
    expect(desk.calls[0]?.args["dryRun"]).toBe(true);
    const payload = readEntries(dir).find((e) => e.kind === "order")?.payload as {
      agentHubRequest: { dryRun: boolean; wouldSend: Record<string, unknown> };
    };
    expect(payload.agentHubRequest.dryRun).toBe(true);
    expect(payload.agentHubRequest.wouldSend["symbol"]).toBe("RTSLAUSDT");
    expect(payload.agentHubRequest.wouldSend["orderType"]).toBe("limit");
    expect(payload.agentHubRequest.wouldSend["price"]).toBe("404.2");
  });

  it("builds the request itself when the SDK will not preview, and says so once", async () => {
    const seen = await perceived();
    const desk = fakeOrderDesk(() => {
      throw new Error("no credentials");
    });
    const { deps: d, dir } = deps({ bitget: desk as never });

    await executeVerdicts(d, "rules", [allow(), allow({ notionalUsdt: 300 })], seen, state(), NOW);

    const entries = readEntries(dir);
    const configs = entries.filter((e) => e.kind === "config");
    expect(configs).toHaveLength(1);
    expect((configs[0]?.payload as { agentHubPreview: string }).agentHubPreview).toBe("built locally");
    const payload = entries.find((e) => e.kind === "order")?.payload as {
      agentHubRequest: { builtLocally: boolean; wouldSend: Record<string, unknown> };
    };
    expect(payload.agentHubRequest.builtLocally).toBe(true);
    expect(payload.agentHubRequest.wouldSend["clientOid"]).toContain("kaaval-rules-");
  });

  it("carries a stop on every position it opens and drops it when the position closes", async () => {
    const seen = await perceived();
    const { deps: d } = deps();

    const opened = await executeVerdicts(d, "rules", [allow()], seen, state(), NOW);
    const stop = opened.state.stops[0];
    expect(opened.state.stops).toHaveLength(1);
    expect(stop?.symbol).toBe("RTSLAUSDT");
    expect(stop?.side).toBe("sell");
    const entry = opened.state.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.avgEntry ?? 0;
    expect(stop?.triggerPrice).toBeCloseTo(entry * 0.97, 9);

    const held = opened.state.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.qty ?? 0;
    const bid = seen.quotes.get(positionKey("SPOT", "RTSLAUSDT"))?.bid ?? 0;
    const closed = await executeVerdicts(
      d,
      "rules",
      [allow({ side: "sell", notionalUsdt: held * bid, reduceOnly: true })],
      seen,
      opened.state,
      new Date(NOW.getTime() + 60_000),
    );
    expect(closed.state.account.positions.size).toBe(0);
    expect(closed.state.stops).toHaveLength(0);
  });

  it("cuts a stop down with the position it protects", async () => {
    const seen = await perceived();
    const { deps: d } = deps();

    const opened = await executeVerdicts(d, "rules", [allow()], seen, state(), NOW);
    const trigger = opened.state.stops[0]?.triggerPrice ?? 0;
    const half = (opened.state.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.qty ?? 0) / 2;

    const reduced = await executeVerdicts(
      d,
      "rules",
      [allow({ side: "sell", notionalUsdt: half * (seen.quotes.get(positionKey("SPOT", "RTSLAUSDT"))?.bid ?? 0), reduceOnly: true })],
      seen,
      opened.state,
      new Date(NOW.getTime() + 60_000),
    );

    const held = reduced.state.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.qty ?? 0;
    expect(reduced.state.stops).toHaveLength(1);
    expect(reduced.state.stops[0]?.qty).toBe(held);
    expect(reduced.state.stops[0]?.triggerPrice).toBe(trigger);
  });

  it("writes the stop it arms beside the order that opens the position", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    await executeVerdicts(d, "rules", [allow()], seen, state(), NOW);

    const payload = readEntries(dir).find((e) => e.kind === "order")?.payload as {
      stopRequest: Record<string, unknown>;
    };
    expect(payload.stopRequest["type"]).toBe("tpsl");
    expect(payload.stopRequest["symbol"]).toBe("RTSLAUSDT");
    expect(payload.stopRequest["posSide"]).toBe("long");
    // Three percent under the 404.2 touch, which is the rulebook's rToken stop.
    expect(payload.stopRequest["stopLoss"]).toBe("392.074");
  });

  it("arms a stop on a perpetual hedge, which is where Bitget would take one", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    await executeVerdicts(
      d,
      "rules",
      [allow({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "sell", notionalUsdt: 200, hedgeFor: "RTSLAUSDT" })],
      seen,
      state(),
      NOW,
    );

    const payload = readEntries(dir).find((e) => e.kind === "order")?.payload as {
      stopRequest: Record<string, unknown>;
    };
    expect(payload.stopRequest["posSide"]).toBe("short");
    // Two percent over the 401.8 touch it sold at, which is the rulebook's perpetual stop.
    expect(payload.stopRequest["stopLoss"]).toBe("409.836");
  });

  it("arms no stop on an order that only cuts a position", async () => {
    const seen = await perceived();
    const { deps: d, dir } = deps();

    const opened = await executeVerdicts(d, "rules", [allow()], seen, state(), NOW);
    const held = opened.state.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.qty ?? 0;
    const bid = seen.quotes.get(positionKey("SPOT", "RTSLAUSDT"))?.bid ?? 0;
    await executeVerdicts(
      d,
      "rules",
      [allow({ side: "sell", notionalUsdt: held * bid, reduceOnly: true })],
      seen,
      opened.state,
      new Date(NOW.getTime() + 60_000),
    );

    const orders = readEntries(dir).filter((e) => e.kind === "order");
    expect((orders.at(-1)?.payload as { stopRequest: unknown }).stopRequest).toBeNull();
  });

  it("replaces the stop when a perpetual position flips from long to short", async () => {
    const seen = await perceived();
    const { deps: d } = deps();
    const perp = { category: "USDT-FUTURES", symbol: "TSLAUSDT" } as const;

    const long = await executeVerdicts(
      d,
      "rules",
      [allow({ ...perp, side: "buy", notionalUsdt: 400 })],
      seen,
      state(),
      NOW,
    );
    expect(long.state.stops[0]?.side).toBe("sell");
    expect(long.state.stops[0]?.positionSide).toBe("long");

    // Sold down through flat to a short smaller than the long it replaced, which is the
    // case a size check alone reads as a position that was merely cut.
    const flipped = await executeVerdicts(
      d,
      "rules",
      [allow({ ...perp, side: "sell", notionalUsdt: 600 })],
      seen,
      long.state,
      new Date(NOW.getTime() + 60_000),
    );

    const position = flipped.state.account.positions.get(positionKey("USDT-FUTURES", "TSLAUSDT"));
    expect(position?.side).toBe("short");
    expect(flipped.state.stops).toHaveLength(1);
    expect(flipped.state.stops[0]?.positionSide).toBe("short");
    expect(flipped.state.stops[0]?.side).toBe("buy");
    expect(flipped.state.stops[0]?.triggerPrice).toBeCloseTo((position?.avgEntry ?? 0) * 1.02, 9);
    expect(flipped.state.stops[0]?.qty).toBeCloseTo(position?.qty ?? 0, 12);
  });

  it("sends only the three demo contracts to the demo environment", async () => {
    const seen = await perceived();
    const demo = fakeOrderDesk(() => ({ orderId: "demo-1", clientOid: "kaaval" }));
    const { deps: d, dir } = deps({ demo: demo as never });

    const done = await executeVerdicts(
      d,
      "rules",
      [
        allow({ category: "USDT-FUTURES", symbol: "BTCUSDT", side: "sell", notionalUsdt: 300, hedgeFor: "RTSLAUSDT" }),
        allow({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "sell", notionalUsdt: 300, hedgeFor: "RTSLAUSDT" }),
      ],
      seen,
      state(),
      NOW,
    );

    expect(demo.calls).toHaveLength(1);
    expect(demo.calls[0]?.args["symbol"]).toBe("SBTCSUSDT");
    const fills = readEntries(dir).filter((e) => e.kind === "fill").map((e) => e.payload as { demo: boolean; fill: { symbol: string } });
    expect(fills.map((f) => [f.fill.symbol, f.demo])).toEqual([
      ["BTCUSDT", true],
      ["TSLAUSDT", false],
    ]);
    expect(done.fills).toHaveLength(2);
  });
});
