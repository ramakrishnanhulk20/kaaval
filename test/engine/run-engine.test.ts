// The body of the engine loop: what happens to the run when a whole tick throws. Does NOT
// cover the loop's sleeping and signal handling, the universe rebuild, the brains it builds
// from the environment, or pm2: those are the wrapper around this function, not this
// function.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RulesBrain } from "../../src/brain/rules.js";
import type { CalendarEvent } from "../../src/brain/types.js";
import { newEngineState } from "../../src/engine/state.js";
import type { TickDeps } from "../../src/engine/tick.js";
import { buildUniverse } from "../../src/engine/universe.js";
import { loadOrCreateKeyPair } from "../../src/ledger/keys.js";
import { Ledger, readEntries } from "../../src/ledger/ledger.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import type { Category, FeeSchedule, SlippageModel } from "../../src/sim/types.js";
import { tickOnce } from "../../scripts/run-engine.js";
import { bookAround, fakeMarket, fakeOrderDesk, previewOf } from "../support/fake-bitget.js";

const NOW = new Date("2026-09-11T02:00:00Z");

const FEES: Record<Category, FeeSchedule> = {
  SPOT: { makerRate: 0.001, takerRate: 0.001 },
  "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 },
};
const MODEL: SlippageModel = { maxBookFraction: 0.25, extraBps: 5 };

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

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("tickOnce", () => {
  it("survives a tick that throws, writes nothing to the ledger, and asks for the normal cadence", async () => {
    const market = fakeMarket({ quotes, books, tradedOverWeekend: ["RTSLAUSDT"], candleClose: 400 });
    const universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
      maxSymbols: 1,
      cacheFile: join(temp("kaaval-loop-uni-"), "universe.json"),
      ttlMs: 60_000,
      now: NOW,
    });
    const ledgerDir = temp("kaaval-loop-ledger-");
    const ledger = new Ledger(ledgerDir, loadOrCreateKeyPair(join(temp("kaaval-loop-key-"), "ledger-key.pem")));
    const lines: string[] = [];
    const stateFile = join(temp("kaaval-loop-state-"), "engine.json");
    const deps: TickDeps = {
      rulebook: DEFAULT_RULEBOOK,
      brains: [new RulesBrain()],
      ledger,
      stateFile,
      tradeLogFile: join(temp("kaaval-loop-log-"), "trades.csv"),
      killFile: join(temp("kaaval-loop-kill-"), "KILL"),
      log: (line) => lines.push(line),
      decisionTimeoutMs: 5_000,
      perception: {
        bitget: market,
        cacheDir: temp("kaaval-loop-news-"),
        log: () => {},
        news: () => {
          throw new Error("the news feed is down");
        },
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
    };
    const state = newEngineState(["rules"], 10_000, NOW);

    const result = await tickOnce(deps, universe, state, NOW);

    expect(result.nextTickMs).toBe(DEFAULT_RULEBOOK.cadence.normalMinutes * 60_000);
    expect(result.window).toBe("normal");
    expect(lines.some((line) => line.includes("tick failed, the run continues"))).toBe(true);
    expect(readEntries(ledgerDir)).toHaveLength(0);
  });
});
