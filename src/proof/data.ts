import "dotenv/config";
import { createBitget } from "../bitget/client.js";
import { estimateCost } from "../bitget/cost.js";
import { divergence } from "../bitget/divergence.js";
import { classifyWeekendTrading, nyseClock, tradableNow } from "../bitget/hours.js";
import {
  getCandles,
  getFunding,
  getInstrument,
  getTicker,
  listStockInstruments,
} from "../bitget/market.js";
import type { Category, Instrument } from "../bitget/types.js";

/**
 * Midnight ET on Saturday 5 September 2026 through midnight ET on Monday 7 September.
 * New York was on daylight time, so ET midnight is 04:00 UTC. This is the window the
 * weekend numbers below are measured over.
 */
const WEEKEND = {
  start: Date.parse("2026-09-05T04:00:00Z"),
  end: Date.parse("2026-09-07T04:00:00Z"),
};

/** 16:00 ET on Friday 4 September 2026, the last regular close before that weekend. */
const FRIDAY_CLOSE = Date.parse("2026-09-04T20:00:00Z");

const FIFTEEN_MIN = 15 * 60 * 1000;

const WATCHLIST: Array<{ category: Category; symbol: string }> = [
  { category: "SPOT", symbol: "RTSLAUSDT" },
  { category: "SPOT", symbol: "RNVDAUSDT" },
  { category: "SPOT", symbol: "RSPYUSDT" },
  { category: "USDT-FUTURES", symbol: "TSLAUSDT" },
  { category: "USDT-FUTURES", symbol: "BTCUSDT" },
];

const utc = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)}${value}`);
}

async function main(): Promise<void> {
  const ctx = createBitget();
  const clock = nyseClock();

  console.log("KAAVAL DATA LAYER, LIVE AGAINST BITGET");
  console.log(`  now                   ${clock.nowEt}`);
  console.log(`  regular session       ${clock.regularSessionOpen ? "open" : "closed"}`);
  console.log(`  last regular close    ${utc(clock.lastRegularClose)}`);
  console.log(`  next regular open     ${utc(clock.nextRegularOpen)}`);

  const { rTokens, perps } = await listStockInstruments(ctx);
  console.log(
    `  instruments           ${rTokens.length} rTokens on spot, ${perps.length} stock perpetuals`,
  );

  const byKey = new Map<string, Instrument>();
  for (const instrument of [...rTokens, ...perps]) {
    byKey.set(`${instrument.category}:${instrument.symbol}`, instrument);
  }

  console.log("");
  console.log(
    `Scanning all ${rTokens.length} rTokens for volume between ${utc(WEEKEND.start)} and ${utc(WEEKEND.end)}.`,
  );
  const startedAt = Date.now();
  const weekendTraded = await classifyWeekendTrading(
    ctx,
    "SPOT",
    rTokens.map((i) => i.symbol),
    WEEKEND,
  );
  const tradedCount = [...weekendTraded.values()].filter(Boolean).length;
  console.log(`Scan finished in ${((Date.now() - startedAt) / 1000).toFixed(0)} seconds.`);

  for (const entry of WATCHLIST) {
    const instrument =
      byKey.get(`${entry.category}:${entry.symbol}`) ??
      (await getInstrument(ctx, entry.category, entry.symbol));
    const [ticker, drift, cost] = await Promise.all([
      getTicker(ctx, entry.category, entry.symbol),
      divergence(ctx, entry.category, entry.symbol),
      estimateCost(ctx, {
        category: entry.category,
        symbol: entry.symbol,
        side: "buy",
        notionalUsdt: 20,
        taker: true,
      }),
    ]);
    const roundTheClock = weekendTraded.get(entry.symbol) ?? false;
    const status = tradableNow(instrument, roundTheClock);
    const spreadBps = ((ticker.ask - ticker.bid) / ((ticker.ask + ticker.bid) / 2)) * 10_000;

    console.log("");
    console.log(`${entry.symbol}  (${entry.category})`);
    line("last", ticker.last.toString());
    line("bid / ask", `${ticker.bid} / ${ticker.ask}`);
    line("spread", `${spreadBps.toFixed(2)} bps`);
    line("24h volume", `${ticker.volume24h.toLocaleString("en-US")} ${instrument.baseCoin}`);
    line(
      "tradable now",
      `${status.tradable ? "yes" : "no"} on ${status.venue}, ${status.reason}`,
    );
    if (status.nextOpen !== undefined) line("next open", utc(status.nextOpen));
    if (status.nextClose !== undefined) line("next close", utc(status.nextClose));
    if (status.nextOpen === undefined && status.nextClose === undefined) {
      line("next US open", `${utc(clock.nextRegularOpen)} (this venue never closes)`);
    }
    line(
      "divergence",
      `${drift.pct.toFixed(3)} percent from ${drift.anchorPrice} anchored on the 15m candle at ${utc(drift.anchorTs)}`,
    );
    line(
      "20 USDT taker buy",
      `avg ${cost.avgFillPrice.toFixed(4)}, impact ${cost.impactBps.toFixed(2)} bps, fee ${cost.feeBps.toFixed(2)} bps, funding ${cost.fundingBpsPerDay === null ? "n/a" : `${cost.fundingBpsPerDay.toFixed(2)} bps/day`}, total ${cost.totalBps.toFixed(2)} bps`,
    );
    line(
      "fill",
      `${cost.fillable ? "fillable" : "NOT fillable"} across ${cost.levelsConsumed} level(s)`,
    );
    if (cost.warnings.length > 0) {
      for (const warning of cost.warnings) line("warning", warning);
    }
    if (entry.category === "USDT-FUTURES") {
      const funding = await getFunding(ctx, entry.symbol);
      line(
        "funding",
        `${(funding.rate * 100).toFixed(4)} percent every ${funding.intervalHours}h, next at ${utc(funding.nextTime)}`,
      );
    }
  }

  console.log("");
  console.log("WEEKEND OF 5 TO 6 SEPTEMBER 2026");
  const anchorCandles = await getCandles(ctx, "SPOT", "RTSLAUSDT", "15m", {
    since: FRIDAY_CLOSE - 4 * 60 * 60 * 1000,
    until: FRIDAY_CLOSE,
  });
  const anchor =
    anchorCandles.find((c) => c.ts === FRIDAY_CLOSE - FIFTEEN_MIN) ?? anchorCandles.at(-1);
  if (!anchor) {
    throw new Error("no RTSLAUSDT 15m candle before the Friday close, cannot anchor the weekend");
  }
  const weekendCandles = await getCandles(ctx, "SPOT", "RTSLAUSDT", "15m", {
    since: WEEKEND.start,
    until: WEEKEND.end,
  });
  let worst = { pct: 0, ts: WEEKEND.start, price: anchor.close };
  for (const candle of weekendCandles) {
    const pct = ((candle.close - anchor.close) / anchor.close) * 100;
    if (Math.abs(pct) > Math.abs(worst.pct)) {
      worst = { pct, ts: candle.ts, price: candle.close };
    }
  }
  line("anchor", `${anchor.close} at ${utc(anchor.ts)} (15m candle ending at the Friday bell)`);
  line("15m candles", `${weekendCandles.length} inside the window`);
  line(
    "max divergence",
    `${worst.pct.toFixed(3)} percent at ${utc(worst.ts)}, price ${worst.price}`,
  );
  line(
    "rTokens that traded",
    `${tradedCount} of ${rTokens.length} had volume during the weekend`,
  );
}

await main();
