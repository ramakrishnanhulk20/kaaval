import { existsSync } from "node:fs";
import { nyseClock } from "../bitget/hours.js";
import type { AccountView, Brain, Decision } from "../brain/types.js";
import type { Ledger } from "../ledger/ledger.js";
import { checkAll, lossState, requiredHedges, targetsToIntents, type OrderIntent, type RiskContext } from "../risk/limits.js";
import { rulebookText, type Rulebook } from "../risk/rulebook.js";
import { triggeredStops } from "../risk/stops.js";
import { markToMarket, positionKey } from "../sim/account.js";
import { tickWindow, type TickWindow } from "./clock.js";
import { executeVerdicts, type ExecutionDeps, type Executed } from "./execution.js";
import { perceive, type PerceptionDeps, type Perceived } from "./perception.js";
import { accountView, rememberMarks, rollDay, saveState, type BrainState, type EngineState } from "./state.js";
import { appendTradeLog } from "./tradelog.js";
import { universeKeys, type Universe } from "./universe.js";

/**
 * How far back a tick reads the news. It used to read only what was published since the
 * previous tick, fifteen minutes earlier, and every source we have lags more than that:
 * GDELT by an hour or more, a filing by however long it takes to be written up. So the
 * brains were handed "no news in this window" on all but a handful of ticks in the first
 * week. A rolling window shows a story for as long as it is still moving the price.
 */
function newsLookbackMs(): number {
  const hours = Number(process.env["KAAVAL_NEWS_LOOKBACK_HOURS"] ?? "");
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000;
}

export interface TickDeps {
  rulebook: Rulebook;
  brains: Brain[];
  perception: PerceptionDeps;
  execution: ExecutionDeps;
  ledger: Ledger;
  stateFile: string;
  tradeLogFile: string;
  killFile: string;
  log: (line: string) => void;
  decisionTimeoutMs: number;
  /**
   * Brains the operator has stood down. A retired brain is flattened like a halted one and
   * is never asked again, so it costs no model call, but it is still marked every tick: its
   * curve stays on the record as it closed instead of stopping mid-air with positions open.
   */
  retired?: ReadonlySet<string>;
}

export const RETIRED_SUMMARY =
  "retired by the operator: this brain is no longer asked, and its record stands as it closed";

/** Whether this ledger's run has already recorded that the kill switch is on. */
const killRecorded = new WeakMap<Ledger, boolean>();

/**
 * One tick: look once, think three times, trade under one rulebook, write it all down.
 *
 * The order is the point. The world is built once and handed to every brain unchanged, so
 * the only thing that can differ between them is the brain. Inside a brain the orders that
 * cut risk go first and they go before the brain speaks: a triggered stop, or, when the
 * kill switch is on or the drawdown halt has been passed, the reduce-only orders that
 * close every position it holds. Only then does the brain decide, and its targets and the
 * hedges the cross-asset rule demands are judged against the account those first orders
 * left behind. A stop that fires and a model that hangs must not wait for each other.
 *
 * A brain that hangs or throws costs its tick and nothing more: the failure is recorded,
 * the state is saved, and the next brain still runs. The timeout stops us waiting, it
 * cannot cancel the model call that is already in flight.
 */
export async function runTick(
  deps: TickDeps,
  universe: Universe,
  state: EngineState,
  now: Date,
): Promise<{ state: EngineState; window: TickWindow; nextTickMs: number }> {
  const rb = deps.rulebook;
  const killActive = existsSync(deps.killFile) || process.env["KAAVAL_HALT"] === "1";
  const wasKilled = killRecorded.get(deps.ledger) ?? everyBrainHalted(state);
  if (killActive !== wasKilled) {
    deps.ledger.append("halt", "kaaval", {
      active: killActive,
      source: existsSync(deps.killFile) ? deps.killFile : "KAAVAL_HALT",
      note: killActive
        ? "the kill switch is on: every position is flattened and no new risk is taken"
        : "the kill switch is off: the engine takes new risk again",
    });
    deps.log(killActive ? "kill switch on, flattening and halting new risk" : "kill switch cleared, trading again");
  }
  killRecorded.set(deps.ledger, killActive);
  if (killActive) {
    for (const brain of Object.values(state.brains)) brain.halted = true;
  } else if (wasKilled) {
    // Lifting the switch only lifts the switch. A brain that is also past the drawdown
    // halt is stopped again inside the loop below, with its own entry saying so.
    for (const brain of Object.values(state.brains)) brain.halted = false;
  }

  const perceived = await perceive(deps.perception, universe, now, now.getTime() - newsLookbackMs());
  const clock = nyseClock(now);
  const { window, nextTickMs } = tickWindow(now, clock, perceived.world.calendar, rb);
  perceived.world.window = window;
  deps.log(
    `tick ${now.toISOString()} ${window} window, ${perceived.world.symbols.length} symbols, ${perceived.world.news.length} news items`,
  );

  const marks = marksOf(perceived);
  const keys = universeKeys(universe);
  const text = rulebookText(rb);

  for (const brain of deps.brains) {
    const brainState = state.brains[brain.name];
    if (!brainState) {
      deps.log(`${brain.name} has no state in this run, skipped`);
      continue;
    }

    const progress = { decisionWritten: false };
    try {
      state.brains[brain.name] = await runBrain(deps, brain, brainState, perceived, marks, keys, text, killActive, now, progress);
    } catch (error) {
      recordBrainFailure(deps, brain.name, perceived, error, progress.decisionWritten);
    }
    // Saved after every brain, not once at the end: a brain that throws must not cost the
    // brains before it the fills they already made.
    try {
      saveState(deps.stateFile, state);
    } catch (error) {
      deps.log(`state could not be saved after ${brain.name}: ${(error as Error).message}`);
    }
  }

  state.lastTickTs = now.getTime();
  state.lastNewsTs = now.getTime();
  saveState(deps.stateFile, state);
  return { state, window, nextTickMs };
}

/**
 * One brain's whole tick, from its own account view to its mark.
 *
 * Everything that cuts risk is executed before decide() is called, so a stop or a flatten
 * cannot be delayed by a model that is thinking, and the brain's own targets are judged
 * against the account those orders left.
 */
async function runBrain(
  deps: TickDeps,
  brain: Brain,
  brainState: BrainState,
  perceived: Perceived,
  marks: Map<string, number>,
  keys: Set<string>,
  text: string,
  killActive: boolean,
  now: Date,
  progress: { decisionWritten: boolean },
): Promise<BrainState> {
  rememberMarks(brainState, marks);

  const opening = markToMarket(brainState.account, marks).equity;
  if (rollDay(brainState, opening, now)) {
    deps.log(`${brain.name}: new UTC day ${brainState.dayKey}, start of day equity ${opening.toFixed(2)}`);
  }
  brainState.peakEquity = Math.max(brainState.peakEquity, opening);

  let current = brainState;
  let view = accountView(current, marks, perceived.quotes);
  for (const position of view.positions) {
    if (position.markSource === "quote") continue;
    deps.log(
      `${brain.name}: no quote for ${position.symbol} this tick, marked at ${position.markSource === "last" ? "the last price we saw" : "its entry price"}, ${position.mark}`,
    );
  }

  let ctx = contextFor(deps, current, view, keys, perceived, killActive);
  const loss = lossState(ctx);
  const retired = deps.retired?.has(brain.name) === true;
  // Retirement closes the book down the kill path: those orders are reduce-only and are the
  // ones the rulebook lets past the entry gates and the size band.
  const haltSource: "kill" | "stop" | null = killActive || retired ? "kill" : loss.halt ? "stop" : null;
  const flatten = haltSource ? flattenIntents(view, perceived, brain.name, haltSource) : [];

  const wantHalted = loss.halt || retired;
  const haltFlipped = !killActive && wantHalted !== current.halted;
  if (haltFlipped) current.halted = wantHalted;
  if (haltFlipped || flatten.length > 0) {
    deps.ledger.append("halt", brain.name, {
      active: killActive || wantHalted,
      source: killActive ? "safety.kill" : retired ? "operator.retired" : "loss.drawdownHaltPct",
      drawdownPct: view.drawdownPct,
      flattened: flatten.map((intent) => ({
        category: intent.category,
        symbol: intent.symbol,
        side: intent.side,
        notionalUsdt: intent.notionalUsdt,
      })),
      note:
        retired && !killActive
          ? `${RETIRED_SUMMARY}; ${flatten.length} open position(s) closed by reduce-only orders this tick`
          : noteFor(killActive, loss.halt, flatten.length),
    });
  }

  // When the book is being flattened the flatten orders are the stop: they close every
  // position, including the ones a stop had already been passed by, and one order per
  // position is what the account can actually sell.
  const cutting = haltSource ? flatten : stopsToIntents(current, perceived, brain.name);
  const first = await execute(deps, brain.name, cutting, ctx, perceived, current, now);
  current = first.state;
  const rows = [...first.rows];

  view = accountView(current, marks, perceived.quotes);
  ctx = contextFor(deps, current, view, keys, perceived, killActive);

  const decision = retired ? standDown(brain.name, perceived) : await decide(brain, perceived, view, text, deps);
  progress.decisionWritten = true;
  current.lastDecisionTs = now.getTime();
  current.lastSummary = decision.summary;

  const wanted = [...requiredHedges(ctx), ...targetsToIntents(decision.targets, view, brain.name)];
  const second = await execute(deps, brain.name, wanted, ctx, perceived, current, now);
  current = second.state;
  rows.push(...second.rows);

  if (rows.length > 0) {
    try {
      appendTradeLog(deps.tradeLogFile, rows);
    } catch (error) {
      // The ledger is the record and scripts/export-log.ts rebuilds this file from it, so a
      // CSV that will not write costs a convenience, not the tick.
      deps.log(`${brain.name}: the trade log could not be appended, ${(error as Error).message}`);
    }
  }

  const closing = accountView(current, marks, perceived.quotes);
  current.peakEquity = Math.max(current.peakEquity, closing.equity);
  deps.ledger.append("mark", brain.name, {
    equity: closing.equity,
    balance: closing.balanceUsdt,
    realised: closing.realisedPnl,
    unrealised: closing.unrealised,
    drawdownPct: closing.drawdownPct,
    dayPnlPct: closing.dayPnlPct,
    positions: closing.positions,
    simulated: true,
  });
  const fills = first.fills.length + second.fills.length;
  deps.log(
    `${brain.name}: equity ${closing.equity.toFixed(2)}, realised ${closing.realisedPnl.toFixed(2)}, unrealised ${closing.unrealised.toFixed(2)}, ${closing.positions.length} positions, ${fills} fills`,
  );
  return current;
}

/** The rulebook's verdict on a batch of intents, then whatever survives it, executed. */
async function execute(
  deps: TickDeps,
  brain: string,
  intents: OrderIntent[],
  ctx: RiskContext,
  perceived: Perceived,
  state: BrainState,
  now: Date,
): Promise<Executed> {
  if (intents.length === 0) return { state, fills: [], rows: [], rejected: [] };

  const verdicts = checkAll(intents, ctx);
  for (const verdict of verdicts) {
    if (verdict.allowed) continue;
    deps.ledger.append("reject", brain, {
      intent: verdict.intent,
      rule: verdict.rule,
      reason: verdict.reason,
    });
    deps.log(`${brain} refused ${verdict.intent.symbol}: ${verdict.reason}`);
  }
  return await executeVerdicts(deps.execution, brain, verdicts, perceived, state, now);
}

function contextFor(
  deps: TickDeps,
  state: BrainState,
  view: AccountView,
  keys: Set<string>,
  perceived: Perceived,
  killActive: boolean,
): RiskContext {
  return {
    world: perceived.world,
    account: view,
    rulebook: deps.rulebook,
    universe: keys,
    startOfDayEquity: state.startOfDayEquity,
    peakEquity: state.peakEquity,
    halted: killActive || state.halted,
  };
}

/**
 * Every open position as the reduce-only order that closes it.
 *
 * The rulebook says a halt flattens the book, so the halt has to place the orders that do
 * it. They are reduce-only and they carry the source that called for them, kill for the
 * switch and stop for the drawdown halt, which is what lets them past the entry gates and
 * the order size band: refusing to shrink a position is how a risk layer traps a loss
 * instead of stopping one. A market that is shut still refuses them, because a closed
 * market cannot fill, and the refusal is in the record.
 */
function flattenIntents(
  view: AccountView,
  perceived: Perceived,
  brain: string,
  source: "kill" | "stop",
): OrderIntent[] {
  const intents: OrderIntent[] = [];
  for (const position of view.positions) {
    if (!(position.notionalUsdt > 0)) continue;
    // Sized at the price this order would get out at, not at the mid, so what it asks for
    // is what the account can actually sell.
    const quote = perceived.quotes.get(positionKey(position.category, position.symbol));
    const exit = position.side === "long" ? quote?.bid : quote?.ask;
    const price = exit !== undefined && exit > 0 ? exit : position.mark;
    // Dust the exchange will not take stays where it is. Asking anyway sells nothing and
    // writes a halt entry and a refusal on every tick for as long as the halt lasts.
    const minimum = perceived.instruments.get(positionKey(position.category, position.symbol))?.minOrderUsdt ?? null;
    if (minimum !== null && position.qty * price < minimum) continue;
    intents.push({
      category: position.category,
      symbol: position.symbol,
      side: position.side === "long" ? "sell" : "buy",
      notionalUsdt: position.qty * price,
      reduceOnly: true,
      hedgeFor: null,
      brain,
      source,
    });
  }
  return intents;
}

function noteFor(killActive: boolean, drawdownHalt: boolean, flattened: number): string {
  if (flattened > 0) {
    return killActive
      ? "the kill switch is on: every open position is flattened by a reduce-only order this tick"
      : "past the drawdown halt in the rulebook: every open position is flattened and no new risk is taken";
  }
  return drawdownHalt
    ? "past the drawdown halt in the rulebook, with nothing open to flatten"
    : "equity is back above the drawdown halt, the engine takes new risk again";
}

/**
 * A brain whose tick threw, written down rather than passed over.
 *
 * A failure before the decision was recorded becomes the decision entry, with the error on
 * it, so the record never reads like a quiet night when it was a broken one. A failure
 * after that entry exists is a log line, because the ledger already says what the brain
 * decided and a second decision entry would be a second story.
 */
function recordBrainFailure(
  deps: TickDeps,
  brain: string,
  perceived: Perceived,
  error: unknown,
  decisionWritten: boolean,
): void {
  const message = (error as Error).message;
  deps.log(`${brain} tick failed: ${message}`);
  if (decisionWritten) return;
  try {
    deps.ledger.append("decision", brain, {
      brain,
      ts: perceived.world.ts,
      targets: [],
      summary: `no decision this tick: ${message}`,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      error: message,
    });
  } catch (writeError) {
    deps.log(`${brain} failure could not be written to the ledger either: ${(writeError as Error).message}`);
  }
}

/**
 * A decision, or an honest record of why there is not one. Anything the brain throws or
 * any wait past the timeout becomes a decision entry with an error and no targets, so a
 * model that failed is visible in the record rather than looking like a quiet night.
 */
/** What a retired brain "decides": nothing, without a model call and without a ledger entry a tick. */
function standDown(brain: string, perceived: Perceived): Decision {
  return {
    brain,
    ts: perceived.world.ts,
    targets: [],
    summary: RETIRED_SUMMARY,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
  };
}

async function decide(
  brain: Brain,
  perceived: Perceived,
  view: AccountView,
  text: string,
  deps: TickDeps,
): Promise<Decision> {
  const started = Date.now();
  try {
    const decision = await withTimeout(
      brain.decide(perceived.world, view, text),
      deps.decisionTimeoutMs,
      `${brain.name} took longer than ${Math.round(deps.decisionTimeoutMs / 1000)} seconds`,
    );
    deps.ledger.append("decision", brain.name, decision);
    return decision;
  } catch (error) {
    const message = (error as Error).message;
    const empty: Decision = {
      brain: brain.name,
      ts: perceived.world.ts,
      targets: [],
      summary: `no decision this tick: ${message}`,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - started,
    };
    deps.ledger.append("decision", brain.name, { ...empty, error: message });
    deps.log(`${brain.name} decision failed: ${message}`);
    return empty;
  }
}

/**
 * A stop that the recorded book has already passed through, as the order that closes it.
 *
 * It is reduce-only and marked as a stop, which is what lets it through the entry gates
 * and the order size band: refusing to shrink a position is how a risk layer traps a loss
 * instead of stopping one.
 */
function stopsToIntents(state: BrainState, perceived: Perceived, brain: string): OrderIntent[] {
  const hit = triggeredStops(state.stops, perceived.quotes);
  const intents: OrderIntent[] = [];
  for (const stop of hit) {
    const key = positionKey(stop.category, stop.symbol);
    const quote = perceived.quotes.get(key);
    const exit = quote ? (stop.side === "sell" ? quote.bid : quote.ask) : stop.triggerPrice;
    intents.push({
      category: stop.category,
      symbol: stop.symbol,
      side: stop.side,
      notionalUsdt: stop.qty * exit,
      reduceOnly: true,
      hedgeFor: null,
      brain,
      source: "stop",
    });
  }
  return intents;
}

function marksOf(perceived: Perceived): Map<string, number> {
  const marks = new Map<string, number>();
  for (const [key, quote] of perceived.quotes) marks.set(key, (quote.bid + quote.ask) / 2);
  return marks;
}

function everyBrainHalted(state: EngineState): boolean {
  const brains = Object.values(state.brains);
  return brains.length > 0 && brains.every((brain) => brain.halted);
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}
