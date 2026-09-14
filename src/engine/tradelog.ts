import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toCsvRows, type LogRow } from "../sim/account.js";

/**
 * The six fields the program asks for, plus which brain traded and why, as one CSV for all
 * three accounts. It is written as the tick happens so a judge can open it mid-run, and the
 * header goes in once, on the first row the file ever sees.
 *
 * The rendering comes from sim/account.ts rather than from a second formatter here, so the
 * live file and the file scripts/export-log.ts rebuilds from the ledger cannot drift apart.
 * Rows are appended, never rewritten: this file is a record, and the ledger is the copy that
 * proves it.
 */
export function appendTradeLog(file: string, rows: LogRow[]): void {
  if (rows.length === 0) return;
  const { header, body } = split(toCsvRows(rows));
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, started(file) ? body : `${header}${body}`, "utf8");
}

/** The whole log from scratch, for the rebuild out of the ledger. */
export function writeTradeLog(file: string, rows: LogRow[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, toCsvRows(rows), "utf8");
}

function started(file: string): boolean {
  return existsSync(file) && statSync(file).size > 0;
}

function split(csv: string): { header: string; body: string } {
  const breakAt = csv.indexOf("\r\n");
  if (breakAt < 0) return { header: csv, body: "" };
  return { header: csv.slice(0, breakAt + 2), body: csv.slice(breakAt + 2) };
}
