// The engine's memory: what survives a restart, how the day rolls over, and the account
// view the brains and the risk layer read. Does NOT cover the ledger (ledger.test.ts),
// fills (sim tests), or concurrent writers: one engine process owns the state file.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountView, loadState, newEngineState, rememberMarks, rollDay, saveState } from "../../src/engine/state.js";
import { applyFill, markToMarket, positionKey } from "../../src/sim/account.js";
import type { Fill } from "../../src/sim/types.js";

const NOW = new Date("2026-09-11T02:00:00Z");

function stateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "kaaval-state-")), "engine.json");
}

const buy: Fill = {
  orderId: "t-1",
  account: "rules",
  category: "SPOT",
  symbol: "RTSLAUSDT",
  side: "buy",
  qty: 2,
  avgPrice: 400,
  notionalUsdt: 800,
  feeUsdt: 0.8,
  slippageBps: 5,
  levelsConsumed: 1,
  partial: false,
  ts: NOW.getTime(),
  bookHash: "a".repeat(64),
};

describe("saveState and loadState", () => {
  it("brings the positions map back through a restart", () => {
    const file = stateFile();
    const state = newEngineState(["claude", "rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;
    rules.account = applyFill(rules.account, buy).account;
    rules.lastSummary = "one basis trade";
    rules.lastDecisionTs = NOW.getTime();
    saveState(file, state);

    const loaded = loadState(file);
    const reloaded = loaded?.brains["rules"];
    expect(reloaded?.account.positions).toBeInstanceOf(Map);
    expect(reloaded?.account.positions.get(positionKey("SPOT", "RTSLAUSDT"))?.qty).toBe(2);
    expect(reloaded?.account.balanceUsdt).toBeCloseTo(10_000 - 800.8, 9);
    expect(reloaded?.lastSummary).toBe("one basis trade");
    expect(loaded?.brains["claude"]?.account.positions.size).toBe(0);
  });

  it("returns null for a first run and throws on a state file it cannot read", () => {
    const file = stateFile();
    expect(loadState(file)).toBeNull();
    writeFileSync(file, '{"version":2,"brains":{}}', "utf8");
    expect(() => loadState(file)).toThrow(/version 2/);
  });
});

describe("rollDay", () => {
  it("resets the start of day equity when the UTC day changes and leaves it alone otherwise", () => {
    const state = newEngineState(["rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;

    expect(rollDay(rules, 9_500, new Date("2026-09-11T20:00:00Z"))).toBe(false);
    expect(rules.startOfDayEquity).toBe(10_000);

    expect(rollDay(rules, 9_500, new Date("2026-09-12T00:01:00Z"))).toBe(true);
    expect(rules.startOfDayEquity).toBe(9_500);
    expect(rules.dayKey).toBe("2026-09-12");
  });
});

describe("accountView", () => {
  it("matches markToMarket and prices a position from its quote when no mark is given", () => {
    const state = newEngineState(["rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;
    rules.account = applyFill(rules.account, buy).account;
    rules.peakEquity = 10_100;

    const key = positionKey("SPOT", "RTSLAUSDT");
    const quotes = new Map([[key, { bid: 409.9, ask: 410.1 }]]);
    const view = accountView(rules, new Map(), quotes);
    const direct = markToMarket(rules.account, new Map([[key, 410]]));

    expect(view.equity).toBeCloseTo(direct.equity, 9);
    expect(view.unrealised).toBeCloseTo(direct.unrealised, 9);
    expect(view.positions[0]?.mark).toBe(410);
    expect(view.positions[0]?.notionalUsdt).toBeCloseTo(820, 9);
    expect(view.drawdownPct).toBeCloseTo(((10_100 - direct.equity) / 10_100) * 100, 9);
    expect(view.dayPnlPct).toBeCloseTo(((direct.equity - 10_000) / 10_000) * 100, 9);
  });

  it("marks a position with no quote at the last price it saw, so the loss stays visible", () => {
    const state = newEngineState(["rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;
    rules.account = applyFill(rules.account, buy).account;

    const key = positionKey("SPOT", "RTSLAUSDT");
    rememberMarks(rules, new Map([[key, 360]]));

    const view = accountView(rules, new Map(), new Map());
    expect(view.positions[0]?.mark).toBe(360);
    expect(view.positions[0]?.markSource).toBe("last");
    // Bought two at 400 and last seen at 360: the 80 USDT loss is still on the books.
    expect(view.positions[0]?.unrealised).toBeCloseTo(-80, 9);
    expect(view.unrealised).toBeCloseTo(-80, 9);
    expect(view.equity).toBeCloseTo(markToMarket(rules.account, new Map([[key, 360]])).equity, 9);
  });

  it("says so when a position has never been quoted and is held at its entry price", () => {
    const state = newEngineState(["rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;
    rules.account = applyFill(rules.account, buy).account;

    const view = accountView(rules, new Map(), new Map());
    expect(view.positions[0]?.mark).toBe(400);
    expect(view.positions[0]?.markSource).toBe("entry");
    expect(view.positions[0]?.unrealised).toBe(0);
  });

  it("prefers this tick's quote to the last price it remembered", () => {
    const state = newEngineState(["rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;
    rules.account = applyFill(rules.account, buy).account;
    const key = positionKey("SPOT", "RTSLAUSDT");
    rememberMarks(rules, new Map([[key, 360]]));

    const view = accountView(rules, new Map(), new Map([[key, { bid: 409.9, ask: 410.1 }]]));
    expect(view.positions[0]?.mark).toBe(410);
    expect(view.positions[0]?.markSource).toBe("quote");
  });

  it("reports no drawdown when equity is above the old peak", () => {
    const state = newEngineState(["rules"], 10_000, NOW);
    const rules = state.brains["rules"]!;
    rules.peakEquity = 9_000;
    expect(accountView(rules, new Map(), new Map()).drawdownPct).toBe(0);
  });
});
