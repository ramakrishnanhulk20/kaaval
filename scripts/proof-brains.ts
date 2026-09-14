import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBitget, type BitgetContext } from "../src/bitget/client.js";
import { divergence } from "../src/bitget/divergence.js";
import { classifyWeekendTrading, nyseClock, tradableNow } from "../src/bitget/hours.js";
import { getFunding, getInstrument, getOpenInterest, getTicker } from "../src/bitget/market.js";
import type { Category } from "../src/bitget/types.js";
import { ClaudeBrain } from "../src/brain/claude.js";
import { AnthropicClient, OpenAiCompatibleClient } from "../src/brain/llm.js";
import { QwenBrain } from "../src/brain/qwen.js";
import type { AccountView, Brain, Decision, WorldState, WorldSymbol } from "../src/brain/types.js";
import { gatherCalendar, gatherNews } from "../src/news/feed.js";

/**
 * The prove-it run for the two language-model brains.
 *
 * Every number the brains see below comes from a live Bitget read or a live news call
 * made in this process. Nothing is stubbed, and the account is a fresh paper account, so
 * what a reader is looking at is the real decision the real prompt produced tonight.
 */

const UNIVERSE: Array<{ category: Category; symbol: string; underlying: string }> = [
  { category: "SPOT", symbol: "RTSLAUSDT", underlying: "TSLA" },
  { category: "SPOT", symbol: "RNVDAUSDT", underlying: "NVDA" },
  { category: "SPOT", symbol: "RAAPLUSDT", underlying: "AAPL" },
  { category: "SPOT", symbol: "RSPYUSDT", underlying: "SPY" },
  { category: "USDT-FUTURES", symbol: "TSLAUSDT", underlying: "TSLA" },
  { category: "USDT-FUTURES", symbol: "BTCUSDT", underlying: "BTC" },
];

const STARTING_EQUITY = 10_000;
const NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;
const CALENDAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ENSEMBLE = { runs: 3, shrink: 0.2, floorConfidence: 0.1, temperature: 0.7 };

/** Half an hour either side of the New York open is when Bitget says rTokens re-anchor. */
const OPEN_WINDOW_MS = 30 * 60 * 1000;
const EVENT_WINDOW_MS = 60 * 60 * 1000;

const CACHE_DIR = resolve(process.cwd(), "data", "state", "news-cache");

const utc = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)}${value}`);
}

async function buildSymbol(
  ctx: BitgetContext,
  entry: (typeof UNIVERSE)[number],
  roundTheClock: boolean,
): Promise<WorldSymbol> {
  const [instrument, ticker] = await Promise.all([
    getInstrument(ctx, entry.category, entry.symbol),
    getTicker(ctx, entry.category, entry.symbol),
  ]);

  let divergencePct: number | null = null;
  if (entry.underlying !== "BTC") {
    try {
      divergencePct = (await divergence(ctx, entry.category, entry.symbol)).pct;
    } catch {
      divergencePct = null;
    }
  }

  let fundingRate: number | null = null;
  let openInterest: number | null = null;
  if (entry.category === "USDT-FUTURES") {
    fundingRate = (await getFunding(ctx, entry.symbol)).rate;
    openInterest = (await getOpenInterest(ctx, entry.symbol)).amount;
  }

  return {
    category: entry.category,
    symbol: entry.symbol,
    underlying: entry.underlying,
    last: ticker.last,
    bid: ticker.bid,
    ask: ticker.ask,
    spreadBps: ((ticker.ask - ticker.bid) / ((ticker.ask + ticker.bid) / 2)) * 10_000,
    // Bitget reports 24 hour volume in the base coin, so the last price converts it.
    volume24hUsdt: ticker.volume24h * ticker.last,
    divergencePct,
    fundingRate,
    openInterest,
    roundTheClock,
    tradable: tradableNow(instrument, roundTheClock).tradable,
  };
}

/**
 * Midnight Saturday to midnight Monday, New York time, for the weekend just gone. The
 * offset is fixed at four hours, which is right on daylight time and an hour out in
 * winter; it decides only whether a symbol traded at all over a two day window, so an
 * hour at the edge cannot change the answer.
 */
function lastWeekend(now: Date): { start: number; end: number } {
  const daysSinceSaturday = (now.getUTCDay() + 1) % 7;
  const saturday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceSaturday,
  );
  const start = saturday + 4 * 60 * 60 * 1000;
  return { start, end: start + 48 * 60 * 60 * 1000 };
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function etField(date: Date, name: string): number {
  for (const part of ET_PARTS.formatToParts(date)) {
    if (part.type === name) return Number(part.value);
  }
  return 0;
}

/**
 * The next 16:00 in New York. Weekends are stepped over; the holiday list lives in
 * bitget/hours.ts and is not repeated here, so on a holiday this reads one day early.
 * It fills one display field of the world state and nothing trades on it.
 */
function nextRegularClose(now: Date): number {
  const wall = (offsetDays: number): number => {
    const base = Date.UTC(
      etField(now, "year"),
      etField(now, "month") - 1,
      etField(now, "day") + offsetDays,
      16,
      0,
    );
    const first = base - etOffsetMs(new Date(base));
    return base - etOffsetMs(new Date(first));
  };
  for (let day = 0; day < 7; day += 1) {
    const close = wall(day);
    const weekday = new Date(close).getUTCDay();
    if (close > now.getTime() && weekday !== 0 && weekday !== 6) return close;
  }
  return wall(0);
}

function etOffsetMs(date: Date): number {
  return (
    Date.UTC(
      etField(date, "year"),
      etField(date, "month") - 1,
      etField(date, "day"),
      etField(date, "hour"),
      etField(date, "minute"),
      etField(date, "second"),
    ) - date.getTime()
  );
}

function reportDecision(brain: string, decision: Decision, invalidRuns: number): void {
  console.log("");
  console.log(`${brain.toUpperCase()} DECISION`);
  line("summary", decision.summary);
  line(
    "cost",
    `${decision.modelCalls} calls, ${decision.promptTokens} prompt tokens, ${decision.completionTokens} completion tokens, ${(decision.latencyMs / 1000).toFixed(1)}s total`,
  );
  line("invalid runs", `${invalidRuns} of ${decision.modelCalls}`);
  if (decision.targets.length === 0) {
    line("targets", "none");
    return;
  }
  for (const target of decision.targets) {
    console.log("");
    line(
      target.symbol,
      `${target.targetNotionalUsdt >= 0 ? "long" : "short"} ${Math.abs(target.targetNotionalUsdt).toFixed(0)} usdt, confidence ${target.confidence.toFixed(2)}, ${target.horizonMinutes} minutes${target.hedgeFor ? `, hedges ${target.hedgeFor}` : ""}`,
    );
    line("rationale", target.rationale);
  }
}

async function runBrain(
  brain: Brain & { lastEnsemble: { invalidRuns: number } | null },
  world: WorldState,
  account: AccountView,
  rulebook: string,
): Promise<void> {
  const decision = await brain.decide(world, account, rulebook);
  reportDecision(brain.name, decision, brain.lastEnsemble?.invalidRuns ?? 0);
}

async function main(): Promise<void> {
  const ctx = createBitget();
  const now = new Date();
  const clock = nyseClock(now);

  console.log("KAAVAL BRAINS, LIVE AGAINST BITGET AND LIVE NEWS");
  line("now", clock.nowEt);
  line("regular session", clock.regularSessionOpen ? "open" : "closed");
  line("next regular open", utc(clock.nextRegularOpen));

  const weekend = lastWeekend(now);
  const weekendTraded = await classifyWeekendTrading(
    ctx,
    "SPOT",
    UNIVERSE.filter((u) => u.category === "SPOT").map((u) => u.symbol),
    weekend,
  );

  const symbols: WorldSymbol[] = [];
  for (const entry of UNIVERSE) {
    symbols.push(
      await buildSymbol(
        ctx,
        entry,
        entry.category === "USDT-FUTURES" ? true : (weekendTraded.get(entry.symbol) ?? false),
      ),
    );
  }

  console.log("");
  console.log("WORLD STATE");
  for (const s of symbols) {
    line(
      s.symbol,
      `last ${s.last}, spread ${s.spreadBps.toFixed(1)} bps, divergence ${s.divergencePct === null ? "n/a" : `${s.divergencePct.toFixed(2)} percent`}, funding ${s.fundingRate === null ? "n/a" : s.fundingRate.toFixed(6)}, ${s.tradable ? "tradable" : "not tradable"}`,
    );
  }

  const notes: string[] = [];
  const log = (l: string): void => {
    notes.push(l);
  };

  console.log("");
  console.log(`NEWS SINCE ${utc(Date.now() - NEWS_WINDOW_MS)}`);
  const news = await gatherNews(
    {
      symbols: UNIVERSE.map((u) => ({ symbol: u.symbol, underlying: u.underlying })),
      sinceTs: Date.now() - NEWS_WINDOW_MS,
      cacheDir: CACHE_DIR,
    },
    log,
  );
  const calendar = await gatherCalendar(
    {
      underlyings: [...new Set(UNIVERSE.map((u) => u.underlying))],
      fromTs: Date.now(),
      toTs: Date.now() + CALENDAR_WINDOW_MS,
      cacheDir: CACHE_DIR,
    },
    log,
  );

  const bySource = new Map<string, number>();
  for (const item of news) {
    const family = item.source.split("/")[0] ?? item.source;
    bySource.set(family, (bySource.get(family) ?? 0) + 1);
  }
  line(
    "items",
    `${news.length} after deduplication (${[...bySource].map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`,
  );
  for (const item of news.slice(0, 5)) {
    line(new Date(item.ts).toISOString().slice(5, 16), `${item.headline} [${item.symbols.join(" ")}]`);
  }
  line("calendar", calendar.length === 0 ? "no events" : `${calendar.length} events`);
  for (const event of calendar.slice(0, 5)) {
    line(new Date(event.ts).toISOString().slice(5, 16), `${event.title} (${event.timing})`);
  }
  for (const note of notes) line("note", note);

  const nextEvent = calendar[0];
  const window: WorldState["window"] =
    nextEvent && nextEvent.ts - Date.now() < EVENT_WINDOW_MS
      ? "event"
      : Math.abs(clock.nextRegularOpen - Date.now()) < OPEN_WINDOW_MS
        ? "open"
        : "normal";

  const world: WorldState = {
    ts: Date.now(),
    clock: {
      nowEt: clock.nowEt,
      regularSessionOpen: clock.regularSessionOpen,
      isWeekend: clock.isWeekend,
      msToNextOpen: clock.nextRegularOpen - Date.now(),
      msToNextClose: nextRegularClose(now) - Date.now(),
    },
    window,
    symbols,
    news,
    calendar,
  };

  const account: AccountView = {
    id: "kaaval-proof",
    equity: STARTING_EQUITY,
    balanceUsdt: STARTING_EQUITY,
    realisedPnl: 0,
    unrealised: 0,
    drawdownPct: 0,
    dayPnlPct: 0,
    positions: [],
  };
  console.log("");
  line("account", `fresh paper account, ${STARTING_EQUITY} usdt, no positions, nothing traded yet`);
  line("window", world.window);

  const rulebook = readFileSync(resolve(process.cwd(), "docs", "rulebook.md"), "utf8");

  await runBrain(
    new ClaudeBrain(new AnthropicClient(), ENSEMBLE),
    world,
    account,
    rulebook,
  );

  if (!process.env["QWEN_API_KEY"]) {
    console.log("");
    console.log("qwen skipped: QWEN_API_KEY not set");
    return;
  }
  await runBrain(new QwenBrain(new OpenAiCompatibleClient(), ENSEMBLE), world, account, rulebook);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
