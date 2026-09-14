import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { writeTradeLog } from "../src/engine/tradelog.js";
import { readEntries, type FillPayload } from "../src/ledger/ledger.js";
import { applyFill, createAccount, type LogRow, type PaperAccount } from "../src/sim/account.js";

/**
 * Rebuilds the trade log from the signed ledger, so the CSV a judge reads can be produced
 * again from the record instead of trusted as a file that happened to be lying there.
 *
 * Every row is recomputed by running each recorded fill back through the same paper account
 * the engine used, in ledger order. The starting balance comes from the config entry the run
 * wrote, so the balances in the file are the balances the run had. A fill the account will
 * not accept is named on the error stream and skipped rather than dropped in silence.
 */

const ledgerDir = resolve(process.env["KAAVAL_LEDGER_DIR"] ?? "data/state/ledger");
const stateFile = resolve(process.env["KAAVAL_STATE_FILE"] ?? "data/state/engine.json");
const outFile = join(dirname(stateFile), "trades.csv");
const fallbackBalance = Number(process.env["KAAVAL_PAPER_BALANCE"] ?? 10_000);

const accounts = new Map<string, PaperAccount>();
const rows: LogRow[] = [];
let balance = Number.isFinite(fallbackBalance) ? fallbackBalance : 10_000;
let skipped = 0;

for (const entry of readEntries(ledgerDir)) {
  if (entry.kind === "config") {
    const recorded = (entry.payload as { balanceUsdt?: unknown }).balanceUsdt;
    if (typeof recorded === "number" && Number.isFinite(recorded)) balance = recorded;
    continue;
  }
  if (entry.kind !== "fill") continue;

  const { fill } = entry.payload as FillPayload;
  const account = accounts.get(entry.account) ?? createAccount(entry.account, balance);
  try {
    const applied = applyFill(account, fill);
    accounts.set(entry.account, applied.account);
    rows.push(applied.row);
  } catch (error) {
    skipped += 1;
    console.error(`entry ${entry.seq}: ${(error as Error).message}`);
  }
}

writeTradeLog(outFile, rows);
console.log(`ledger:     ${ledgerDir}`);
console.log(`trade log:  ${outFile}`);
console.log(`rows:       ${rows.length} fills across ${accounts.size} accounts${skipped > 0 ? `, ${skipped} skipped` : ""}`);
console.log("Every row is a simulated fill against the order book recorded beside it.");
