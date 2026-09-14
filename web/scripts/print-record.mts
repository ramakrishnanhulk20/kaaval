import { getTickerBoard } from "../lib/bitget";
import { dataDir, getCurves, getFirstEntryTs, getMarks, getState, getUniverse, recordPaused } from "../lib/record";

async function main(): Promise<void> {
  console.log("data dir      ", dataDir());

  const state = await getState();
  console.log("brains        ", state.brains.join(", "), `(${String(state.brains.length)})`);
  console.log("halted        ", state.halted.length === 0 ? "none" : state.halted.join(", "));
  console.log("started       ", new Date(state.startedTs).toISOString());
  console.log("last tick     ", new Date(state.lastTickTs).toISOString(), recordPaused(state.lastTickTs, Date.now()) ? "(paused)" : "(live)");
  console.log("balance start ", state.balanceUsdt);

  const first = await getFirstEntryTs();
  console.log("first entry   ", first === null ? "none" : new Date(first).toISOString());
  console.log("marks         ", (await getMarks()).length);
  for (const curve of await getCurves()) {
    const last = curve.points.at(-1);
    console.log(
      `  curve ${curve.brain.padEnd(8)} points ${String(curve.points.length).padStart(3)}  last equity ${last ? last.equity.toFixed(2) : "none"}`,
    );
  }

  const universe = await getUniverse();
  console.log("universe      ", universe.map((s) => `${s.name}/${s.symbol}`).join(", "));

  const board = await getTickerBoard();
  console.log("tickers as of ", new Date(board.asOf).toISOString(), board.error ?? "");
  for (const row of board.rows) {
    console.log(`  ${row.name.padEnd(6)} ${row.last.toFixed(2).padStart(10)}  ${row.changePct === null ? "n/a" : `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%`}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
