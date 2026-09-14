// One whole tick end to end: perceive, decide, judge, execute, record, the order the
// entries land in, flattening on a halt, the six-field CSV, and one brain's failure not
// costing the next one. Does NOT cover the live Bitget API, real model calls (the brains
// have their own tests and proof script), or the pm2 wrapper around the loop.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RulesBrain } from "../../src/brain/rules.js";
import type { AccountView, Brain, CalendarEvent, Decision, NewsItem, WorldState } from "../../src/brain/types.js";
import { runTick, type TickDeps } from "../../src/engine/tick.js";
import { newEngineState, type BrainState, type EngineState } from "../../src/engine/state.js";
import { buildUniverse, type Universe } from "../../src/engine/universe.js";
import { loadOrCreateKeyPair, type KeyPair } from "../../src/ledger/keys.js";
import { Ledger, readEntries, replayFills, verifyLedger, type ConfigPayload, type LedgerEntry, type LedgerKind } from "../../src/ledger/ledger.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import { stopFor } from "../../src/risk/stops.js";
import { applyFill, positionKey } from "../../src/sim/account.js";
import type { Category, Fill, FeeSchedule, SlippageModel } from "../../src/sim/types.js";
import { bookAround, fakeMarket, fakeOrderDesk, previewOf } from "../support/fake-bitget.js";

const NOW = new Date("2026-09-11T02:00:00Z");
const BALANCE = 10_000;

const FEES: Record<Category, FeeSchedule> = {
  SPOT: { makerRate: 0.001, takerRate: 0.001 },
  "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 },
};
const MODEL: SlippageModel = { maxBookFraction: 0.25, extraBps: 5 };

// rTSLA trades 74 basis points under its own perpetual, which is the rules brain's signal.
const quotes = {
  RTSLAUSDT: { last: 400, bid: 399.9, ask: 400.1, usdtVolume: 50_000_000 },
  TSLAUSDT: { last: 403, bid: 402.9, ask: 403.1, usdtVolume: 20_000_000 },
  SPYUSDT: { last: 660, bid: 659.9, ask: 660.1, usdtVolume: 5_000_000 },
  BTCUSDT: { last: 60_000, bid: 59_990, ask: 60_010, usdtVolume: 900_000_000 },
  ETHUSDT: { last: 3_000, bid: 2_999, ask: 3_001, usdtVolume: 400_000_000 },
};

const books = {
  RTSLAUSDT: bookAround(400, 50),
  TSLAUSDT: bookAround(403, 50),
  SPYUSDT: bookAround(660, 50),
  BTCUSDT: bookAround(60_000, 5),
  ETHUSDT: bookAround(3_000, 20),
};

/** Proposes more than the rulebook allows and a symbol that is not in the universe. */
class GreedyBrain implements Brain {
  readonly name = "greedy";

  async decide(world: WorldState, account: AccountView): Promise<Decision> {
    return {
      brain: this.name,
      ts: world.ts,
      targets: [
        {
          category: "SPOT",
          symbol: "RTSLAUSDT",
          targetNotionalUsdt: account.equity * 0.5,
          hedgeFor: null,
          rationale: "half the book on one name, to see the rulebook cut it",
          confidence: 0.9,
          horizonMinutes: 60,
        },
        {
          category: "SPOT",
          symbol: "RDOGEUSDT",
          targetNotionalUsdt: 400,
          hedgeFor: null,
          rationale: "a symbol that is not in tonight's universe",
          confidence: 0.9,
          horizonMinutes: 60,
        },
      ],
      summary: "one oversize target and one that does not exist",
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 1,
    };
  }
}

class HangingBrain implements Brain {
  readonly name = "hanging";

  async decide(): Promise<Decision> {
    return await new Promise<Decision>(() => {});
  }
}

/** Wants nothing, so what lands in the ledger is only what the engine itself decided. */
class QuietBrain implements Brain {
  constructor(readonly name: string) {}

  async decide(world: WorldState): Promise<Decision> {
    return {
      brain: this.name,
      ts: world.ts,
      targets: [],
      summary: "nothing to do",
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 1,
    };
  }
}

/** A ledger whose disk refuses one account's entries of one kind, and nobody else's. */
class FlakyLedger extends Ledger {
  #failFor: { account: string; kind: LedgerKind } | null = null;

  failOn(account: string, kind: LedgerKind): void {
    this.#failFor = { account, kind };
  }

  override append(kind: LedgerKind, account: string, payload: unknown): LedgerEntry {
    if (this.#failFor && this.#failFor.account === account && this.#failFor.kind === kind) {
      throw new Error("the disk refused this entry");
    }
    return super.append(kind, account, payload);
  }
}

/** Puts a held rToken and the stop that goes with it into a brain's state. */
function seedPosition(state: BrainState, qty: number, price: number, ts: number): void {
  const fill: Fill = {
    orderId: "seed-1",
    account: state.account.id,
    category: "SPOT",
    symbol: "RTSLAUSDT",
    side: "buy",
    qty,
    avgPrice: price,
    notionalUsdt: qty * price,
    feeUsdt: qty * price * 0.001,
    slippageBps: 0,
    levelsConsumed: 1,
    partial: false,
    ts,
    bookHash: "s".repeat(64),
  };
  state.account = applyFill(state.account, fill).account;
  state.stops = [
    stopFor(
      {
        category: "SPOT",
        symbol: "RTSLAUSDT",
        side: "long",
        qty,
        avgEntry: price,
        mark: price,
        notionalUsdt: qty * price,
        unrealised: 0,
      },
      DEFAULT_RULEBOOK,
      ts,
    ),
  ];
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface Harness {
  deps: TickDeps;
  universe: Universe;
  state: EngineState;
  ledgerDir: string;
  killFile: string;
  tradeLogFile: string;
  ledger: FlakyLedger;
  publicKeyHex: string;
}

async function harness(brains: Brain[], over: Partial<TickDeps> = {}): Promise<Harness> {
  const market = fakeMarket({ quotes, books, tradedOverWeekend: ["RTSLAUSDT"], candleClose: 400 });
  const universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
    maxSymbols: 1,
    cacheFile: join(temp("kaaval-tick-uni-"), "universe.json"),
    ttlMs: 60_000,
    now: NOW,
  });

  const ledgerDir = temp("kaaval-tick-ledger-");
  const keys: KeyPair = loadOrCreateKeyPair(join(temp("kaaval-tick-key-"), "ledger-key.pem"));
  const ledger = new FlakyLedger(ledgerDir, keys);
  ledger.append("config", "kaaval", {
    fees: FEES,
    model: MODEL,
    feeSource: "test fixture",
  } satisfies ConfigPayload);

  const state = newEngineState(brains.map((b) => b.name), BALANCE, NOW);
  const killFile = join(temp("kaaval-tick-kill-"), "KILL");
  const tradeLogFile = join(temp("kaaval-tick-log-"), "trades.csv");

  return {
    universe,
    state,
    ledgerDir,
    killFile,
    tradeLogFile,
    ledger,
    publicKeyHex: keys.publicKeyHex,
    deps: {
      rulebook: DEFAULT_RULEBOOK,
      brains,
      ledger,
      stateFile: join(temp("kaaval-tick-state-"), "engine.json"),
      tradeLogFile,
      killFile,
      log: () => {},
      decisionTimeoutMs: 5_000,
      perception: {
        bitget: market,
        cacheDir: temp("kaaval-tick-news-"),
        log: () => {},
        news: async (): Promise<NewsItem[]> => [],
        calendar: async (): Promise<CalendarEvent[]> => [],
      },
      execution: {
        bitget: fakeOrderDesk(previewOf) as never,
        demo: null,
        ledger,
        rulebook: DEFAULT_RULEBOOK,
        fees: FEES,
        model: MODEL,
        log: () => {},
      },
      ...over,
    },
  };
}

function kindsFor(dir: string, account: string): string[] {
  return readEntries(dir)
    .filter((entry) => entry.account === account)
    .map((entry) => entry.kind);
}

describe("runTick", () => {
  it("writes a decision, a refusal, a fill and a mark for every brain, and the chain holds", async () => {
    const h = await harness([new RulesBrain(), new GreedyBrain()]);

    const result = await runTick(h.deps, h.universe, h.state, NOW);

    expect(result.window).toBe("normal");
    expect(result.nextTickMs).toBe(15 * 60_000);

    const entries = readEntries(h.ledgerDir);
    expect(entries[0]?.kind).toBe("config");
    expect(entries.findIndex((e) => e.kind === "snapshot")).toBeLessThan(
      entries.findIndex((e) => e.kind === "fill"),
    );

    for (const brain of ["rules", "greedy"]) {
      const kinds = kindsFor(h.ledgerDir, brain);
      // Nothing was held going into this tick, so there was no risk to cut before the
      // brain spoke and the decision is the first thing it wrote.
      expect(kinds[0]).toBe("decision");
      expect(kinds.at(-1)).toBe("mark");
      expect(kinds).toContain("order");
      expect(kinds).toContain("fill");
    }

    // The greedy brain asked for half the account in one name and for a symbol that is
    // not listed tonight. The first is cut to the order cap, the second is refused.
    const greedyRejects = entries.filter((e) => e.account === "greedy" && e.kind === "reject");
    expect(greedyRejects).toHaveLength(1);
    expect((greedyRejects[0]?.payload as { rule: string }).rule).toBe("universe.symbol");
    const greedyOrder = entries.find((e) => e.account === "greedy" && e.kind === "order")?.payload as {
      notes: string[];
      order: { qty: number; limitPrice: number };
    };
    expect(greedyOrder.notes.join(" ")).toContain("exposure.maxOrderUsdt");
    expect(greedyOrder.order.qty * greedyOrder.order.limitPrice).toBeLessThanOrEqual(
      DEFAULT_RULEBOOK.exposure.maxOrderUsdt,
    );

    const mark = entries.filter((e) => e.kind === "mark").at(-1)?.payload as {
      simulated: boolean;
      equity: number;
      positions: unknown[];
    };
    expect(mark.simulated).toBe(true);
    expect(mark.positions).toHaveLength(1);
    expect(mark.equity).toBeGreaterThan(0);

    const check = verifyLedger(h.ledgerDir, h.publicKeyHex);
    expect(check.ok).toBe(true);
    expect(check.entries).toBe(entries.length);

    const replay = replayFills(h.ledgerDir);
    expect(replay.length).toBeGreaterThan(0);
    expect(replay.every((row) => row.matches)).toBe(true);
  });

  it("halts on the kill file and trades again when it is removed", async () => {
    const h = await harness([new RulesBrain()]);
    await runTick(h.deps, h.universe, h.state, NOW);
    const before = readEntries(h.ledgerDir).filter((e) => e.kind === "fill").length;
    expect(before).toBeGreaterThan(0);

    writeFileSync(h.killFile, "stop\n", "utf8");
    const halted = await runTick(h.deps, h.universe, h.state, new Date(NOW.getTime() + 900_000));
    const switchEntries = readEntries(h.ledgerDir).filter((e) => e.kind === "halt" && e.account === "kaaval");
    expect(switchEntries).toHaveLength(1);
    expect((switchEntries[0]?.payload as { active: boolean }).active).toBe(true);
    expect(halted.state.brains["rules"]?.halted).toBe(true);
    const refusals = readEntries(h.ledgerDir).filter(
      (e) => e.kind === "reject" && String((e.payload as { reason: string }).reason).includes("kill switch"),
    );
    expect(refusals.length).toBeGreaterThan(0);

    rmSync(h.killFile);
    const resumed = await runTick(h.deps, h.universe, h.state, new Date(NOW.getTime() + 1_800_000));
    const afterSwitch = readEntries(h.ledgerDir).filter((e) => e.kind === "halt" && e.account === "kaaval");
    expect(afterSwitch).toHaveLength(2);
    expect((afterSwitch[1]?.payload as { active: boolean }).active).toBe(false);
    expect(resumed.state.brains["rules"]?.halted).toBe(false);
  });

  it("closes every position when the kill switch goes on, and places nothing on the tick after", async () => {
    const h = await harness([new RulesBrain(), new QuietBrain("quiet")]);
    const quiet = h.state.brains["quiet"]!;
    seedPosition(quiet, 0.5, 400, NOW.getTime());
    await runTick(h.deps, h.universe, h.state, NOW);
    expect(h.state.brains["rules"]?.account.positions.size).toBeGreaterThan(0);
    expect(h.state.brains["quiet"]?.account.positions.size).toBe(1);

    writeFileSync(h.killFile, "stop\n", "utf8");
    const killed = await runTick(h.deps, h.universe, h.state, new Date(NOW.getTime() + 900_000));
    for (const name of ["rules", "quiet"]) {
      expect(killed.state.brains[name]?.account.positions.size).toBe(0);
      const halt = readEntries(h.ledgerDir).find((e) => e.kind === "halt" && e.account === name)?.payload as {
        source: string;
        flattened: Array<{ symbol: string }>;
      };
      expect(halt.source).toBe("safety.kill");
      expect(halt.flattened.length).toBeGreaterThan(0);
    }

    const soFar = readEntries(h.ledgerDir).length;
    await runTick(h.deps, h.universe, h.state, new Date(NOW.getTime() + 1_800_000));
    const after = readEntries(h.ledgerDir).slice(soFar);
    expect(after.filter((e) => e.kind === "order")).toHaveLength(0);
    expect(after.filter((e) => e.kind === "fill")).toHaveLength(0);
    expect(after.filter((e) => e.kind === "halt")).toHaveLength(0);
  });

  it("closes every position when a brain falls past the drawdown halt", async () => {
    const h = await harness([new QuietBrain("quiet")]);
    const quiet = h.state.brains["quiet"]!;
    seedPosition(quiet, 0.5, 400, NOW.getTime());
    // An equity peak far above the account, which is the drawdown the rulebook halts on.
    quiet.peakEquity = 40_000;

    const done = await runTick(h.deps, h.universe, h.state, NOW);

    expect(done.state.brains["quiet"]?.account.positions.size).toBe(0);
    expect(done.state.brains["quiet"]?.halted).toBe(true);
    const halt = readEntries(h.ledgerDir).find((e) => e.kind === "halt")?.payload as {
      active: boolean;
      source: string;
      flattened: Array<{ symbol: string; side: string }>;
    };
    expect(halt.active).toBe(true);
    expect(halt.source).toBe("loss.drawdownHaltPct");
    expect(halt.flattened).toEqual([expect.objectContaining({ symbol: "RTSLAUSDT", side: "sell" })]);
  });

  it("executes a triggered stop before the brain is asked anything", async () => {
    const h = await harness([new QuietBrain("quiet")]);
    const quiet = h.state.brains["quiet"]!;
    // Held at 500 with a stop at 485, and rTSLA trades at 400 this tick.
    seedPosition(quiet, 0.5, 500, NOW.getTime());

    await runTick(h.deps, h.universe, h.state, NOW);

    expect(kindsFor(h.ledgerDir, "quiet")).toEqual(["order", "fill", "decision", "mark"]);
    expect(h.state.brains["quiet"]?.account.positions.size).toBe(0);
    const order = readEntries(h.ledgerDir).find((e) => e.kind === "order")?.payload as {
      intent: { source: string; reduceOnly: boolean };
    };
    expect(order.intent.source).toBe("stop");
    expect(order.intent.reduceOnly).toBe(true);
  });

  it("appends every fill of the tick to the six-field CSV", async () => {
    const h = await harness([new RulesBrain()]);

    await runTick(h.deps, h.universe, h.state, NOW);

    const fills = readEntries(h.ledgerDir).filter((e) => e.kind === "fill");
    expect(fills.length).toBeGreaterThan(0);
    const lines = readFileSync(h.tradeLogFile, "utf8").split("\r\n").filter((line) => line !== "");
    expect(lines[0]).toBe("timestamp,instrument,direction,price,quantity,balanceChange,balanceAfter,account,note");
    expect(lines).toHaveLength(fills.length + 1);
    expect(lines[1]).toContain("RTSLAUSDT");
    expect(lines[1]).toContain("rules");

    await runTick(h.deps, h.universe, h.state, new Date(NOW.getTime() + 900_000));
    const grown = readFileSync(h.tradeLogFile, "utf8").split("\r\n").filter((line) => line !== "");
    expect(grown[0]).toBe(lines[0]);
    expect(grown.length).toBeGreaterThanOrEqual(lines.length);
  });

  it("keeps going to the next brain when one brain's tick throws", async () => {
    const h = await harness([new QuietBrain("boom"), new RulesBrain()]);
    const boom = h.state.brains["boom"]!;
    seedPosition(boom, 0.5, 500, NOW.getTime());
    h.ledger.failOn("boom", "order");

    const done = await runTick(h.deps, h.universe, h.state, NOW);

    const failed = readEntries(h.ledgerDir).find((e) => e.account === "boom" && e.kind === "decision")?.payload as {
      error: string;
      targets: unknown[];
    };
    expect(failed.error).toContain("the disk refused");
    expect(failed.targets).toHaveLength(0);
    expect(readEntries(h.ledgerDir).filter((e) => e.account === "boom" && e.kind === "mark")).toHaveLength(0);

    expect(kindsFor(h.ledgerDir, "rules")).toContain("fill");
    expect(kindsFor(h.ledgerDir, "rules").at(-1)).toBe("mark");
    expect(done.state.brains["rules"]?.account.positions.has(positionKey("SPOT", "RTSLAUSDT"))).toBe(true);
  });

  it("records a brain that never answers as a decision with an error", async () => {
    const h = await harness([new HangingBrain()], { decisionTimeoutMs: 25 });

    await runTick(h.deps, h.universe, h.state, NOW);

    const decision = readEntries(h.ledgerDir).find((e) => e.kind === "decision")?.payload as {
      error: string;
      targets: unknown[];
    };
    expect(decision.error).toContain("longer than");
    expect(decision.targets).toHaveLength(0);
    expect(readEntries(h.ledgerDir).filter((e) => e.kind === "fill")).toHaveLength(0);
  });
});
