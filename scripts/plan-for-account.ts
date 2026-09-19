import "dotenv/config";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBitget, type BitgetContext } from "../src/bitget/client.js";
import { ClaudeBrain } from "../src/brain/claude.js";
import { AnthropicClient, OpenAiCompatibleClient } from "../src/brain/llm.js";
import { QwenBrain } from "../src/brain/qwen.js";
import type { EnsembleOptions } from "../src/brain/ensemble.js";
import { RulesBrain } from "../src/brain/rules.js";
import type { Brain, CalendarEvent, NewsItem } from "../src/brain/types.js";
import type { PerceptionDeps } from "../src/engine/perception.js";
import { buildUniverse, type Universe } from "../src/engine/universe.js";
import { loadOrCreateKeyPair } from "../src/ledger/keys.js";
import { Ledger, verifyLedger } from "../src/ledger/ledger.js";
import { gatherCalendar, gatherNews } from "../src/news/feed.js";
import { DEFAULT_RULEBOOK } from "../src/risk/rulebook.js";
import { checkConnection, contextFor } from "../src/tenant/credentials.js";
import { planForAccount, type Plan, type PlanDeps } from "../src/tenant/plan.js";
import { bookAround, fakeMarket } from "../test/support/fake-bitget.js";
import { fakeTenant } from "../test/tenant/fake-tenant.js";

/**
 * What Kaaval would do tonight with one real Bitget account, and nothing else.
 *
 * With BITGET_TENANT_API_KEY, BITGET_TENANT_SECRET_KEY and BITGET_TENANT_PASSPHRASE set
 * it checks the key with one read, builds the account view from the real balances and
 * positions, and prints every order each brain would have sent, with the rulebook's
 * verdict on each one and a fill against tonight's order book. No order is sent: the
 * surface those credentials go through is read-only and every order is a dry run.
 *
 * With none of the three set it runs the same code against a fake Bitget and a fixture
 * account, so the command always shows the shape. The live path is one key away.
 */

const UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;

/** A Wednesday night in New York. Fixed so the fake run prints the same plan every time. */
const FAKE_NOW = new Date("2026-09-11T02:00:00Z");

const FAKE_QUOTES = {
  RTSLAUSDT: { last: 404, bid: 403.9, ask: 404.1, usdtVolume: 50_000_000 },
  TSLAUSDT: { last: 402, bid: 401.9, ask: 402.1, usdtVolume: 20_000_000 },
  SPYUSDT: { last: 660, bid: 659.9, ask: 660.1, usdtVolume: 5_000_000 },
  BTCUSDT: { last: 60_000, bid: 59_990, ask: 60_010, usdtVolume: 900_000_000 },
  ETHUSDT: { last: 3_000, bid: 2_999, ask: 3_001, usdtVolume: 400_000_000 },
};

const FAKE_BOOKS = {
  RTSLAUSDT: bookAround(404, 50),
  TSLAUSDT: bookAround(402, 50),
  SPYUSDT: bookAround(660, 50),
  BTCUSDT: bookAround(60_000, 5),
  ETHUSDT: bookAround(3_000, 20),
};

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/**
 * The plan's own key names come first; the engine's plain BITGET_* names are the fallback,
 * so one read-only key pasted once serves the engine, the plan and the sister app alike.
 */
function tenantEnv(name: "API_KEY" | "SECRET_KEY" | "PASSPHRASE"): string {
  return env(`BITGET_TENANT_${name}`, env(`BITGET_${name}`, ""));
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A file name a shell can type: an account id from Bitget is a number, but never trust it. */
function safeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned === "" ? "tenant" : cleaned;
}

/** The engine's own ensemble settings, so a plan is decided the way a live tick is. */
const ENSEMBLE: EnsembleOptions = { runs: 3, shrink: 0.2, floorConfidence: 0.1, temperature: 0.7 };

function brains(): Brain[] {
  const list: Brain[] = [new RulesBrain(DEFAULT_RULEBOOK)];
  if (env("QWEN_API_KEY", "")) list.push(new QwenBrain(new OpenAiCompatibleClient(), ENSEMBLE));
  else if (env("ANTHROPIC_API_KEY", "")) list.push(new ClaudeBrain(new AnthropicClient(), ENSEMBLE));
  else console.log("no model brain: neither QWEN_API_KEY nor ANTHROPIC_API_KEY is set");
  return list;
}

async function livePlan(): Promise<{ plan: Plan; ledgerDir: string; publicKeyHex: string }> {
  const creds = {
    apiKey: tenantEnv("API_KEY"),
    secretKey: tenantEnv("SECRET_KEY"),
    passphrase: tenantEnv("PASSPHRASE"),
  };

  const ctx = contextFor(creds);
  const check = await checkConnection(creds, ctx);
  if (!check.ok) {
    console.error(`that key did not work: ${check.reason}`);
    console.error(check.retryable ? "worth trying again in a minute" : "trying again will not help");
    process.exit(1);
  }
  const accountId = safeId(check.uid ?? "tenant");
  console.log(
    `key accepted for account ${accountId}: ${check.equityUsdt.toFixed(2)} USDT of equity, ${check.positions} positions`,
  );

  const market = createBitget();
  const universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
    maxSymbols: envNumber("KAAVAL_MAX_SYMBOLS", 6),
    cacheFile: resolve(env("KAAVAL_UNIVERSE_FILE", "data/state/universe.json")),
    ttlMs: UNIVERSE_TTL_MS,
  });

  const perception: PerceptionDeps = {
    bitget: market,
    news: gatherNews,
    calendar: gatherCalendar,
    cacheDir: resolve(env("KAAVAL_NEWS_CACHE", "data/state/news-cache")),
    log: (line) => console.log(line),
  };

  // One ledger per account, so a trader's record is their own and can be handed over or
  // deleted without touching anybody else's.
  const ledgerDir = resolve("data/state/tenant-ledger", accountId);
  const keys = loadOrCreateKeyPair(resolve(env("KAAVAL_LEDGER_KEY", "data/secrets/ledger-key.pem")));
  const deps: PlanDeps = {
    perception,
    universe,
    brains: brains(),
    rulebook: DEFAULT_RULEBOOK,
    ctx,
    ledger: new Ledger(ledgerDir, keys),
    startOfDayEquity: null,
    peakEquity: null,
  };

  return { plan: await planForAccount(deps, accountId), ledgerDir, publicKeyHex: keys.publicKeyHex };
}

async function fakePlan(): Promise<{ plan: Plan; ledgerDir: string; publicKeyHex: string }> {
  const market = fakeMarket({
    quotes: FAKE_QUOTES,
    books: FAKE_BOOKS,
    tradedOverWeekend: ["RTSLAUSDT"],
    candleClose: 400,
  });
  const universe: Universe = await buildUniverse(market, DEFAULT_RULEBOOK, {
    maxSymbols: 1,
    cacheFile: join(temp("kaaval-fake-plan-uni-"), "universe.json"),
    ttlMs: UNIVERSE_TTL_MS,
    now: FAKE_NOW,
  });

  const perception: PerceptionDeps = {
    bitget: market,
    cacheDir: temp("kaaval-fake-plan-news-"),
    log: () => {},
    news: async (): Promise<NewsItem[]> => [],
    calendar: async (): Promise<CalendarEvent[]> => [],
  };

  // The fake run writes its ledger to a temporary folder. A demonstration must not leave
  // entries behind that look like a real trader's record.
  const ledgerDir = temp("kaaval-fake-plan-ledger-");
  const keys = loadOrCreateKeyPair(join(temp("kaaval-fake-plan-key-"), "ledger-key.pem"));
  const ctx: BitgetContext = fakeTenant();
  const deps: PlanDeps = {
    perception,
    universe,
    brains: [new RulesBrain(DEFAULT_RULEBOOK)],
    rulebook: DEFAULT_RULEBOOK,
    ctx,
    ledger: new Ledger(ledgerDir, keys),
    startOfDayEquity: null,
    peakEquity: null,
    now: FAKE_NOW,
  };

  return { plan: await planForAccount(deps, "fake-tenant"), ledgerDir, publicKeyHex: keys.publicKeyHex };
}

function money(value: number): string {
  return value.toFixed(2).padStart(10);
}

/**
 * What the shadow account is worth before any of these orders: free cash plus the
 * holdings Kaaval can trade.
 *
 * It is deliberately not the equity Bitget reports at the top of this printout. That one
 * also counts coins outside the universe and cash tied up as margin, so comparing the
 * mark to it would read as a loss that no order caused. Both numbers are shown, and the
 * mark is compared with the one it came from.
 */
function shadowStart(plan: Plan): number {
  let total = plan.before.balanceUsdt;
  for (const position of plan.before.positions) {
    total += position.category === "SPOT" ? position.notionalUsdt : position.unrealised;
  }
  return total;
}

function printPlan(plan: Plan): void {
  console.log("");
  console.log(`KAAVAL PLAN ${plan.id}`);
  console.log(`  at ${new Date(plan.ts).toISOString()}, ${plan.window} window`);
  console.log(`  rulebook ${plan.rulebookHash.slice(0, 16)}, universe ${plan.universe.join(", ")}`);
  console.log("");
  console.log("THE ACCOUNT BEFORE");
  console.log(
    `  equity ${money(plan.before.equity)} USDT   free cash ${money(plan.before.balanceUsdt)} USDT   open profit ${money(plan.before.unrealised)} USDT`,
  );
  if (plan.before.positions.length === 0) console.log("  no positions");
  for (const position of plan.before.positions) {
    const source = (position as { entrySource?: string }).entrySource;
    console.log(
      `  ${position.category.padEnd(13)} ${position.symbol.padEnd(11)} ${position.side.padEnd(5)} ${position.qty} at ${position.avgEntry.toFixed(4)}` +
        `  marked ${position.mark.toFixed(4)}  worth ${money(position.notionalUsdt)}${source === "mark" ? "  (entry price unknown, held at the mark)" : ""}`,
    );
  }

  for (const brain of plan.brains) {
    console.log("");
    console.log(`BRAIN ${brain.brain}`);
    if (brain.error !== null) console.log(`  no decision: ${brain.error}`);
    if (brain.decision) {
      console.log(`  says: ${brain.decision.summary}`);
      for (const target of brain.decision.targets) {
        console.log(
          `  wants ${target.category} ${target.symbol} at ${target.targetNotionalUsdt.toFixed(2)} USDT: ${target.rationale}`,
        );
      }
      if (brain.decision.targets.length === 0) console.log("  wants nothing tonight");
    }

    console.log("  the rulebook says");
    if (brain.verdicts.length === 0) console.log("    nothing to judge");
    for (const verdict of brain.verdicts) {
      const head = `    ${verdict.intent.side.padEnd(4)} ${verdict.intent.symbol.padEnd(11)} ${money(verdict.intent.notionalUsdt)} USDT`;
      if (verdict.allowed) {
        console.log(`${head}  allowed${verdict.notes.length > 0 ? `, ${verdict.notes.join("; ")}` : ""}`);
      } else {
        console.log(`${head}  refused by ${verdict.rule}: ${verdict.reason}`);
      }
    }

    console.log("  the orders it would have sent");
    if (brain.orders.length === 0) console.log("    none");
    for (const order of brain.orders) {
      const sent = (order.dryRun["wouldSend"] ?? {}) as Record<string, unknown>;
      const path = String(order.dryRun["path"] ?? "");
      console.log(
        `    ${String(sent["side"] ?? "")} ${String(sent["qty"] ?? "")} ${String(sent["symbol"] ?? "")} ${String(sent["orderType"] ?? "")}` +
          `${sent["price"] === undefined ? "" : ` at ${String(sent["price"])}`}  ->  POST ${path}`,
      );
      const fill = order.shadowFill;
      if (fill === null) console.log("      no book to fill against in this pass");
      else if ("rejected" in fill) console.log(`      shadow fill refused: ${fill.reason}`);
      else
        console.log(
          `      shadow fill ${fill.qty} at ${fill.avgPrice.toFixed(4)}, fee ${fill.feeUsdt.toFixed(4)} USDT, slippage ${fill.slippageBps.toFixed(2)} bps, book ${fill.bookHash.slice(0, 12)}`,
        );
    }

    const start = shadowStart(plan);
    const change = brain.shadowMark.equityAfter - start;
    console.log(
      `  if every one of those had filled: the part of this account Kaaval trades goes from ${money(start)} to ${money(brain.shadowMark.equityAfter)} USDT` +
        ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}), realised ${brain.shadowMark.realised.toFixed(4)}, open ${brain.shadowMark.unrealised.toFixed(4)}`,
    );
  }
  console.log("");
  console.log("Nothing above was sent to Bitget. Every order is a dry run on a read-only key.");
}

async function main(): Promise<void> {
  const live =
    tenantEnv("API_KEY") !== "" &&
    tenantEnv("SECRET_KEY") !== "" &&
    tenantEnv("PASSPHRASE") !== "";

  if (!live) console.log("no tenant key set; run the fake plan");
  const { plan, ledgerDir, publicKeyHex } = live ? await livePlan() : await fakePlan();
  printPlan(plan);

  // A fixture plan is a demonstration of the shape, not a record: it never lands beside the
  // real plans, because the site reads that folder and must show nothing a judge could
  // mistake for a real account.
  const planDir = live ? resolve("data/state/plans") : mkdtempSync(join(tmpdir(), "kaaval-fake-plan-"));
  const file = resolve(planDir, `${plan.accountId}-${plan.ts}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`plan written to ${file}`);

  if (plan.ledgerSeqRange) {
    const verified = verifyLedger(ledgerDir, publicKeyHex);
    console.log(
      `ledger entries ${plan.ledgerSeqRange[0]} to ${plan.ledgerSeqRange[1]} in ${ledgerDir}: ` +
        `${verified.ok ? `chain and signatures check out over ${verified.entries} entries` : `BROKEN at ${String(verified.firstBad)}, ${String(verified.reason)}`}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).stack ?? String(error));
  process.exit(1);
});
