import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBitget, type BitgetContext } from "../src/bitget/client.js";
import { ClaudeBrain } from "../src/brain/claude.js";
import { AnthropicClient, OpenAiCompatibleClient } from "../src/brain/llm.js";
import { QwenBrain } from "../src/brain/qwen.js";
import { RulesBrain } from "../src/brain/rules.js";
import type { AccountView, Brain } from "../src/brain/types.js";
import type { EnsembleOptions } from "../src/brain/ensemble.js";
import { accountView, loadState, newBrainState, newEngineState, saveState, type EngineState } from "../src/engine/state.js";
import { perceive, type PerceptionDeps } from "../src/engine/perception.js";
import { runTick, type TickDeps } from "../src/engine/tick.js";
import type { TickWindow } from "../src/engine/clock.js";
import { buildUniverse, type Universe } from "../src/engine/universe.js";
import { loadOrCreateKeyPair } from "../src/ledger/keys.js";
import { Ledger } from "../src/ledger/ledger.js";
import { gatherCalendar, gatherNews } from "../src/news/feed.js";
import { DEFAULT_RULEBOOK, rulebookText } from "../src/risk/rulebook.js";
import type { Category, FeeSchedule, SlippageModel } from "../src/sim/types.js";

/**
 * Kaaval's engine loop.
 *
 * It builds the universe from Bitget's own data, ticks on the rulebook's cadence, and
 * writes every decision, refusal, order, fill and mark to the signed ledger. Nothing here
 * holds real money: stock legs fill in the simulator against the order book recorded in
 * the same tick, and every entry says so.
 *
 *   --once      one tick, then exit
 *   --dry-run   perceive and decide, execute nothing, write nothing
 */

/**
 * Bitget's published rates, read on 8 September 2026 from
 * https://api.bitget.com/api/v2/spot/public/symbols and
 * https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES.
 * They go in the ledger's config entry because a replay must charge what we charged.
 */
const FEES: Record<Category, FeeSchedule> = {
  SPOT: { makerRate: 0.001, takerRate: 0.001 },
  "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 },
};

const FEE_SOURCE =
  "Bitget public fee rates read 8 September 2026: rToken spot 0.1 percent, stock perps 0.02 and 0.06 percent";

/** Five basis points against us on every fill, on top of walking the recorded book. */
const EXTRA_SLIPPAGE_BPS = 5;

const UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;

/** How far back the first tick of a run looks for news. Later ticks look since the last one. */
const FIRST_NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

const ENSEMBLE_SHRINK = 0.2;
const ENSEMBLE_FLOOR_CONFIDENCE = 0.1;
const ENSEMBLE_TEMPERATURE = 0.7;

/** Claude takes about 27 seconds a call and an ensemble is three of them. */
const DEFAULT_DECISION_TIMEOUT_MS = 180_000;

/**
 * How long a whole tick may take before the engine treats it as hung. Ticks measured on
 * the live run took 60 to 100 seconds each, so ten minutes is silence, not slowness.
 */
const DEFAULT_TICK_TIMEOUT_MS = 10 * 60_000;

/** In the event and open windows the next tick is two minutes out, so the budget is tighter. */
const BUSY_WINDOW_TICK_TIMEOUT_MS = 4 * 60_000;

const DEMO_SYMBOLS = "SBTCSUSDT, SETHSUSDT, SXRPSUSDT";

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

/**
 * The demo environment, when all three demo credentials are set.
 *
 * The SDK reads its credentials from BITGET_API_KEY and friends, so the demo key is put
 * in place for the length of this call and taken straight back out. Nothing is printed
 * and nothing is written to disk.
 */
function createDemoContext(): BitgetContext | null {
  const key = env("BITGET_DEMO_API_KEY", "");
  const secret = env("BITGET_DEMO_SECRET_KEY", "");
  const passphrase = env("BITGET_DEMO_PASSPHRASE", "");
  if (!key || !secret || !passphrase) return null;

  const saved = {
    key: process.env["BITGET_API_KEY"],
    secret: process.env["BITGET_SECRET_KEY"],
    passphrase: process.env["BITGET_PASSPHRASE"],
  };
  process.env["BITGET_API_KEY"] = key;
  process.env["BITGET_SECRET_KEY"] = secret;
  process.env["BITGET_PASSPHRASE"] = passphrase;
  try {
    return createBitget({ readOnly: false, paperTrading: true, modules: "trade" });
  } finally {
    restore("BITGET_API_KEY", saved.key);
    restore("BITGET_SECRET_KEY", saved.secret);
    restore("BITGET_PASSPHRASE", saved.passphrase);
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * The context the Agent Hub dry runs are built through. The SDK answers a dryRun from its
 * safety layer before it looks at a credential or the network, so this never sends an
 * order; every call this engine makes through it carries dryRun true.
 */
function createOrderDesk(): BitgetContext {
  try {
    return createBitget({ readOnly: false, modules: "trade" });
  } catch (error) {
    log(`order desk falling back to read-only: ${(error as Error).message}`);
    return createBitget({ modules: "trade" });
  }
}

function buildBrains(ensemble: EnsembleOptions): Brain[] {
  const brains: Brain[] = [];
  if (env("ANTHROPIC_API_KEY", "")) {
    brains.push(new ClaudeBrain(new AnthropicClient(), ensemble));
  } else {
    log("claude skipped: ANTHROPIC_API_KEY is not set");
  }
  if (env("QWEN_API_KEY", "")) {
    brains.push(new QwenBrain(new OpenAiCompatibleClient(), ensemble));
  } else {
    log("qwen skipped: QWEN_API_KEY is not set");
  }
  brains.push(new RulesBrain(DEFAULT_RULEBOOK));
  return brains;
}

/** Three model runs on a quiet fifteen minute tick, two when the tick is every two minutes. */
function runsFor(window: "normal" | "event" | "open"): number {
  const override = process.env["KAAVAL_ENSEMBLE_RUNS"];
  if (override !== undefined && override.trim() !== "") {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return window === "normal" ? 3 : 2;
}

let wake: (() => void) | null = null;
let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(() => {
      wake = null;
      done();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      done();
    };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const rb = DEFAULT_RULEBOOK;

  const ledgerDir = resolve(env("KAAVAL_LEDGER_DIR", "data/state/ledger"));
  const stateFile = resolve(env("KAAVAL_STATE_FILE", "data/state/engine.json"));
  const killFile = resolve(env("KAAVAL_KILL_FILE", "data/state/KILL"));
  const keyFile = resolve(env("KAAVAL_LEDGER_KEY", "data/secrets/ledger-key.pem"));
  const cacheDir = resolve(env("KAAVAL_NEWS_CACHE", "data/state/news-cache"));
  const universeFile = resolve(env("KAAVAL_UNIVERSE_FILE", "data/state/universe.json"));
  const balance = envNumber("KAAVAL_PAPER_BALANCE", 10_000);
  const maxSymbols = envNumber("KAAVAL_MAX_SYMBOLS", 6);
  const decisionTimeoutMs = envNumber("KAAVAL_DECISION_TIMEOUT_MS", DEFAULT_DECISION_TIMEOUT_MS);
  const tickTimeoutMs = envNumber("KAAVAL_TICK_TIMEOUT_MS", DEFAULT_TICK_TIMEOUT_MS);

  const market = createBitget();
  const ensemble: EnsembleOptions = {
    runs: runsFor("normal"),
    shrink: ENSEMBLE_SHRINK,
    floorConfidence: ENSEMBLE_FLOOR_CONFIDENCE,
    temperature: ENSEMBLE_TEMPERATURE,
  };
  const brains = buildBrains(ensemble);
  const names = brains.map((b) => b.name);

  const perception: PerceptionDeps = {
    bitget: market,
    news: gatherNews,
    calendar: gatherCalendar,
    cacheDir,
    log,
  };

  let universe = await buildUniverse(market, rb, {
    maxSymbols,
    cacheFile: universeFile,
    ttlMs: UNIVERSE_TTL_MS,
  });
  log(
    `universe: ${universe.entries.map((e) => e.rToken.symbol).join(", ") || "empty"}, hedges ${universe.hedges.map((h) => h.symbol).join(", ")}`,
  );

  if (dryRun) {
    await dryRunOnce(perception, universe, brains, balance);
    return;
  }

  const demo = createDemoContext();
  const keys = loadOrCreateKeyPair(keyFile);
  const ledger = new Ledger(ledgerDir, keys);
  const model: SlippageModel = { maxBookFraction: rb.gates.maxBookFraction, extraBps: EXTRA_SLIPPAGE_BPS };

  ledger.append("config", "kaaval", {
    rulebook: rulebookText(rb),
    fees: FEES,
    feeSource: FEE_SOURCE,
    model,
    brains: names,
    balanceUsdt: balance,
    maxSymbols,
    universe: universe.entries.map((e) => e.rToken.symbol),
    demoEnvironment: demo ? `on for ${DEMO_SYMBOLS}` : "off, no demo key",
    publicKeyHex: keys.publicKeyHex,
    note: "every fill in this ledger is simulated",
  });

  const state = loadState(stateFile) ?? newEngineState(names, balance, new Date());
  for (const name of names) {
    if (!state.brains[name]) {
      state.brains[name] = newBrainState(name, balance, new Date());
      log(`${name} joins this run with a fresh ${balance} USDT paper account`);
    }
  }

  const deps: TickDeps = {
    rulebook: rb,
    brains,
    perception,
    execution: { bitget: createOrderDesk(), demo, ledger, rulebook: rb, fees: FEES, model, log },
    ledger,
    stateFile,
    tradeLogFile: tradeLogFileFor(stateFile),
    killFile,
    log,
    decisionTimeoutMs,
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log(`${signal} received, finishing this tick and saving`);
      wake?.();
    });
  }

  let window: TickWindow = "normal";
  while (!stopping) {
    const now = new Date();
    if (now.getTime() - universe.builtTs > UNIVERSE_TTL_MS) {
      universe = await refreshUniverse(market, universeFile, maxSymbols, ledger);
    }
    ensemble.runs = runsFor(window);
    const result = await tickOnce(deps, universe, state, now, {
      // The window of the tick that just finished. A tick cannot know its own window
      // until it has read the clock and the calendar, and the watchdog has to be armed
      // before that, so the last one we saw is the best guess available here.
      timeoutMs: tickBudgetMs(window, tickTimeoutMs),
      log,
      onOverrun: () => saveState(stateFile, state),
      exit: (code) => process.exit(code),
    });
    window = result.window;
    if (once) break;
    if (stopping) break;
    log(`next tick in ${Math.round(result.nextTickMs / 60_000)} minutes`);
    await sleep(result.nextTickMs);
  }

  saveState(stateFile, state);
  log("stopped, state saved");
}

/** The six-field trade log sits beside the state file, so one path setting places both. */
export function tradeLogFileFor(stateFile: string): string {
  return join(dirname(stateFile), "trades.csv");
}

/**
 * The body of the engine loop: one tick, and a tick that throws does not end the run.
 *
 * A tick can fail on anything outside our control, a Bitget outage or a disk that will not
 * take a write. Nothing is invented in the ledger when that happens: an entry saying the
 * engine halted would be a claim about risk that is not true, and an entry saying a brain
 * decided nothing would be a claim about a brain that never ran. The error goes to the log,
 * the state we do have is saved, and the loop sleeps until the next cadence and looks again.
 */
export async function tickOnce(
  deps: TickDeps,
  universe: Universe,
  state: EngineState,
  now: Date,
  watchdog?: Watchdog,
): Promise<{ window: TickWindow; nextTickMs: number }> {
  try {
    const work = runTick(deps, universe, state, now);
    const result = watchdog ? await watchTick(work, watchdog) : await work;
    return { window: result.window, nextTickMs: result.nextTickMs };
  } catch (error) {
    deps.log(`tick failed, the run continues: ${(error as Error).message}`);
    try {
      saveState(deps.stateFile, state);
    } catch (saveError) {
      deps.log(`state could not be saved after the failed tick: ${(saveError as Error).message}`);
    }
    return { window: "normal", nextTickMs: deps.rulebook.cadence.normalMinutes * 60_000 };
  }
}

export interface Watchdog {
  timeoutMs: number;
  log: (line: string) => void;
  /** Save whatever the run has. Called once, just before the process goes. */
  onOverrun: () => void;
  exit: (code: number) => void;
}

/** The budget for this tick, capped in the windows where the next tick is two minutes out. */
export function tickBudgetMs(window: TickWindow, base: number): number {
  return window === "normal" ? base : Math.min(base, BUSY_WINDOW_TICK_TIMEOUT_MS);
}

/**
 * Run one tick against a stopwatch, and end the run if it overruns.
 *
 * On 11 September a tick started at 11:38 UTC, printed its first line, and never printed
 * another: three and a half hours of silence until the machine was rebooted. A promise
 * that is already stuck cannot be cancelled from here, so carrying on with the loop would
 * leave that work hanging inside the process forever. Exiting is the honest recovery: the
 * state file is written first, pm2 starts the engine again thirty seconds later, and the
 * ledger chains across the restart because it is read from disk. Code 2 says this was the
 * watchdog and not a clean stop.
 */
export async function watchTick<T>(work: Promise<T>, dog: Watchdog): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      dog.log(`tick watchdog: ${Math.round(dog.timeoutMs / 1000)} seconds, exiting for pm2 to restart`);
      try {
        dog.onOverrun();
      } catch (error) {
        dog.log(`state could not be saved before the watchdog exit: ${(error as Error).message}`);
      }
      void flushOutput().then(() => {
        dog.exit(2);
        reject(new Error("tick watchdog: the tick overran its budget"));
      });
    }, dog.timeoutMs);
  });

  try {
    return await Promise.race([work, overrun]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wait for the lines already logged to leave the process. pm2 hands the engine a pipe for
 * stdout and a write to a pipe finishes later, so exiting straight away can take the
 * watchdog's own message with it. A second is the most this waits.
 */
function flushOutput(graceMs = 1_000): Promise<void> {
  return new Promise((done) => {
    let left = 2;
    const step = (): void => {
      left -= 1;
      if (left === 0) done();
    };
    setTimeout(done, graceMs).unref();
    process.stdout.write("", step);
    process.stderr.write("", step);
  });
}

async function refreshUniverse(
  market: BitgetContext,
  cacheFile: string,
  maxSymbols: number,
  ledger: Ledger,
): Promise<Universe> {
  const universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
    maxSymbols,
    cacheFile,
    ttlMs: 0,
  });
  ledger.append("config", "kaaval", {
    universe: universe.entries.map((e) => e.rToken.symbol),
    hedges: universe.hedges.map((h) => h.symbol),
    note: "the daily universe rebuild, from Bitget instruments, turnover and weekend tape",
  });
  log(`universe rebuilt: ${universe.entries.map((e) => e.rToken.symbol).join(", ")}`);
  return universe;
}

/**
 * One tick with the trading taken out: the same world, the same prompts, the same
 * decisions, and nothing written anywhere. This is what gets run before a live run.
 */
async function dryRunOnce(
  perception: PerceptionDeps,
  universe: Universe,
  brains: Brain[],
  balance: number,
): Promise<void> {
  const now = new Date();
  const perceived = await perceive(perception, universe, now, now.getTime() - FIRST_NEWS_WINDOW_MS);

  console.log("");
  console.log("DRY RUN. Nothing is executed and nothing is written to the ledger.");
  console.log(`clock:      ${perceived.world.clock.nowEt}, regular session ${perceived.world.clock.regularSessionOpen ? "open" : "shut"}`);
  console.log(`news:       ${perceived.world.news.length} items, ${perceived.world.calendar.length} calendar events`);
  console.log("");
  for (const symbol of perceived.world.symbols) {
    console.log(
      `  ${symbol.symbol.padEnd(12)}last ${symbol.last}, spread ${symbol.spreadBps.toFixed(1)} bps, divergence ${symbol.divergencePct === null ? "n/a" : `${symbol.divergencePct.toFixed(2)} percent`}, ${symbol.tradable ? "tradable" : "not tradable"}`,
    );
  }

  const account: AccountView = accountView(
    newBrainState("dry-run", balance, now),
    new Map(),
    perceived.quotes,
  );
  const text = rulebookText(DEFAULT_RULEBOOK);

  for (const brain of brains) {
    console.log("");
    try {
      const decision = await brain.decide(perceived.world, account, text);
      console.log(`${brain.name}: ${decision.summary}`);
      for (const target of decision.targets) {
        console.log(
          `  ${target.symbol.padEnd(12)}${target.targetNotionalUsdt >= 0 ? "long" : "short"} ${Math.abs(target.targetNotionalUsdt).toFixed(0)} usdt, confidence ${target.confidence.toFixed(2)}: ${target.rationale}`,
        );
      }
      if (decision.targets.length === 0) console.log("  no targets");
    } catch (error) {
      console.log(`${brain.name}: no decision, ${(error as Error).message}`);
    }
  }
}

// The tests pull tickOnce out of this file, so loading the module must not start a run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
