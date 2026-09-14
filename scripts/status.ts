import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadState } from "../src/engine/state.js";
import type { MarkedPosition } from "../src/engine/state.js";
import { ledgerDayFiles, readDay } from "../src/ledger/ledger.js";

/**
 * Where the three paper accounts stand, read from the state file and from the last mark
 * each brain wrote to the ledger. Realised comes before unrealised on every line, because
 * an unrealised number in a thin book is partly our own footprint.
 */

interface MarkPayload {
  equity: number;
  balance: number;
  realised: number;
  unrealised: number;
  drawdownPct: number;
  dayPnlPct: number;
  positions: Array<MarkedPosition | Omit<MarkedPosition, "markSource">>;
  simulated: boolean;
}

const stateFile = resolve(process.env["KAAVAL_STATE_FILE"] ?? "data/state/engine.json");
const ledgerDir = resolve(process.env["KAAVAL_LEDGER_DIR"] ?? "data/state/ledger");
const killFile = resolve(process.env["KAAVAL_KILL_FILE"] ?? "data/state/KILL");

const state = loadState(stateFile);
if (!state) {
  console.log(`No engine state at ${stateFile}. Run the engine once: npx tsx scripts/run-engine.ts --once`);
  process.exit(0);
}

// Newest day first, stopping as soon as every brain has a mark. A run of many nights is
// many files, and the last mark of each account is almost always in the newest one.
const lastMark = new Map<string, { ts: number; mark: MarkPayload }>();
const wanted = Object.keys(state.brains);
for (const file of ledgerDayFiles(ledgerDir).reverse()) {
  const entries = readDay(ledgerDir, file);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "mark" || lastMark.has(entry.account)) continue;
    lastMark.set(entry.account, { ts: entry.ts, mark: entry.payload as MarkPayload });
  }
  if (wanted.every((name) => lastMark.has(name))) break;
}

console.log("KAAVAL STATUS. Every fill below is simulated against a recorded Bitget order book.");
console.log(`state:      ${stateFile}`);
console.log(`ledger:     ${ledgerDir}`);
console.log(`last tick:  ${state.lastTickTs ? `${new Date(state.lastTickTs).toISOString()}, ${ago(state.lastTickTs)}` : "never"}`);
console.log(`kill switch:${existsSync(killFile) ? " ON, no new risk" : " off"}`);

for (const [name, brain] of Object.entries(state.brains)) {
  const seen = lastMark.get(name);
  console.log("");
  console.log(`${name}${brain.halted ? "  [halted]" : ""}`);
  if (seen) {
    const mark = seen.mark;
    console.log(
      `  equity      ${money(mark.equity)} usdt, realised ${money(mark.realised)}, unrealised ${money(mark.unrealised)}`,
    );
    console.log(`  balance     ${money(mark.balance)} usdt free`);
    console.log(
      `  drawdown    ${mark.drawdownPct.toFixed(2)} percent from the peak, ${mark.dayPnlPct.toFixed(2)} percent on the day`,
    );
    console.log(`  marked      ${new Date(seen.ts).toISOString()}, ${ago(seen.ts)}`);
    if (mark.positions.length === 0) {
      console.log("  positions   none");
    }
    for (const position of mark.positions) {
      const source = "markSource" in position ? position.markSource : null;
      console.log(
        `  position    ${position.symbol} ${position.side} ${price(position.qty)} at ${price(position.avgEntry)}, mark ${price(position.mark)} (${markNote(source)}), unrealised ${money(position.unrealised)}`,
      );
    }
  } else {
    console.log("  equity      no mark in the ledger yet");
  }

  if (brain.stops.length === 0) {
    console.log("  stops       none");
  }
  for (const stop of brain.stops) {
    console.log(`  stop        ${stop.symbol} ${stop.side} ${price(stop.qty)} if it trades ${price(stop.triggerPrice)}`);
  }
  console.log(
    `  decision    ${brain.lastDecisionTs ? `${ago(brain.lastDecisionTs)}: ` : ""}${brain.lastSummary || "nothing yet"}`,
  );
}

/**
 * Where a mark came from, so a price that is not this tick's is never read as one. Entries
 * written before the engine recorded this say so rather than claiming a live quote.
 */
function markNote(source: MarkedPosition["markSource"] | null): string {
  if (source === null) return "source not recorded, an entry from before this was kept";
  if (source === "quote") return "live quote";
  return source === "last" ? "last price seen, no quote this tick" : "entry price, never quoted since";
}

/** Prices carry the noise of a float average, and nobody needs to read all of it. */
function price(value: number): string {
  return String(Number(value.toFixed(6)));
}

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ago(ts: number): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}
