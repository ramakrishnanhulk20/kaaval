import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyFill, createAccount, markToMarket, positionKey, toCsvRows } from "../src/sim/account.js";
import type { LogRow, PaperAccount } from "../src/sim/account.js";
import { bookHash } from "../src/sim/book.js";
import { fillAgainstBook } from "../src/sim/fill.js";
import { loadRecordedBook, recordedBookPath } from "../src/sim/recorded.js";
import type { SimOrder } from "../src/sim/types.js";
import { Ledger, replayFills, verifyLedger } from "../src/ledger/ledger.js";
import type { ConfigPayload, FillPayload, SnapshotPayload } from "../src/ledger/ledger.js";
import { loadOrCreateKeyPair } from "../src/ledger/keys.js";

const LEDGER_DIR = "data/state/ledger-demo";
const KEY_FILE = "data/secrets/ledger-key.pem";
const START_BALANCE_USDT = 10_000;

// Bitget's published rates for these two markets, from
// https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES and
// https://api.bitget.com/api/v2/spot/public/symbols. The engine passes them in; the
// simulator never assumes a rate of its own.
const CONFIG: ConfigPayload = {
  fees: {
    SPOT: { makerRate: 0.001, takerRate: 0.001 },
    "USDT-FUTURES": { makerRate: 0.0002, takerRate: 0.0006 },
  },
  model: { maxBookFraction: 0.1, extraBps: 5 },
  feeSource: "Bitget public fee rates read 8 September 2026: rToken spot 0.1 percent, stock perps 0.02 and 0.06 percent",
};

rmSync(LEDGER_DIR, { recursive: true, force: true });

const keys = loadOrCreateKeyPair(KEY_FILE);
const ledger = new Ledger(LEDGER_DIR, keys);
const book = loadRecordedBook("TSLAUSDT");
const hash = bookHash(book);

console.log("Kaaval ledger demo. Everything below is simulated and labelled as such.");
console.log(`book:       ${book.symbol} ${book.category}, recorded ${new Date(book.ts).toISOString()}`);
console.log(`from:       ${recordedBookPath("TSLAUSDT")}`);
console.log(`book hash:  ${hash}`);
console.log("");

ledger.append("config", "kaaval", CONFIG);
ledger.append("snapshot", "kaaval", { bookHash: hash, book } satisfies SnapshotPayload);

const orders: SimOrder[] = [
  {
    id: "demo-1",
    account: "claude",
    category: "USDT-FUTURES",
    symbol: "TSLAUSDT",
    side: "buy",
    type: "market",
    qty: 1.5,
    ts: book.ts,
    source: "brain",
  },
  {
    id: "demo-2",
    account: "claude",
    category: "USDT-FUTURES",
    symbol: "TSLAUSDT",
    side: "sell",
    type: "limit",
    qty: 0.4,
    limitPrice: 364.5,
    ts: book.ts + 60_000,
    source: "stop",
  },
];

let account: PaperAccount = createAccount("claude", START_BALANCE_USDT);
const rows: LogRow[] = [];

for (const order of orders) {
  const result = fillAgainstBook(order, book, CONFIG.fees[order.category], CONFIG.model);
  ledger.append("order", order.account, order);
  if ("rejected" in result) {
    ledger.append("reject", order.account, result);
    console.log(`${order.id} refused: ${result.reason}`);
    continue;
  }
  ledger.append("fill", order.account, { order, fill: result } satisfies FillPayload);
  const applied = applyFill(account, result);
  account = applied.account;
  rows.push(applied.row);
}

const mid = (book.asks[0]!.price + book.bids[0]!.price) / 2;
const marks = new Map([[positionKey("USDT-FUTURES", "TSLAUSDT"), mid]]);
const { equity, unrealised } = markToMarket(account, marks);
ledger.append("mark", account.id, { marks: Object.fromEntries(marks), equity, unrealised, realised: account.realisedPnl });

console.log("the log, in the six fields the form asks for plus who and why");
console.log(toCsvRows(rows).trimEnd());
console.log("");
console.log(`realised:   ${account.realisedPnl.toFixed(6)} USDT (fees ${account.feesPaid.toFixed(6)} included)`);
console.log(`unrealised: ${unrealised.toFixed(6)} USDT`);
console.log(`equity:     ${equity.toFixed(6)} USDT from a ${START_BALANCE_USDT} USDT simulated start`);
console.log("");

report("clean ledger");

const files = readdirSync(LEDGER_DIR).filter((name) => name.endsWith(".jsonl")).sort();
const target = join(LEDGER_DIR, files[0]!);
const original = readFileSync(target, "utf8");
const lines = original.split("\n");
const fillLine = lines.findIndex((line) => line.includes('"kind":"fill"'));
lines[fillLine] = lines[fillLine]!.replace('"qty":1.5', '"qty":1.6');
writeFileSync(target, lines.join("\n"), "utf8");

console.log("");
console.log("now one character of the first fill is changed, from 1.5 to 1.6");
report("edited ledger");

writeFileSync(target, original, "utf8");
console.log("");
console.log("the original file is put back");
report("restored ledger");

function report(label: string): void {
  const check = verifyLedger(LEDGER_DIR, keys.publicKeyHex);
  console.log(`${label}: chain ${check.ok ? "ok" : "BROKEN"}, ${check.entries} entries verified`);
  if (!check.ok) {
    console.log(`${label}: first bad entry ${check.firstBad}, ${check.reason}`);
    return;
  }
  const replay = replayFills(LEDGER_DIR);
  const matched = replay.filter((row) => row.matches).length;
  console.log(`${label}: ${matched} of ${replay.length} fills reproduce from the recorded book`);
}
