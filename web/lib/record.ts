import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as http from "./record-http";
import {
  curvesOf,
  dayOf,
  daysOf,
  decisionOf,
  firstEntryTsOf,
  marksOf,
  parseEntries,
  parseJson,
  refusalsOf,
  rulebookHistoryOf,
  scoreboardOf,
  stateOf,
  universeOf,
  type BrainCurve,
  type DecisionDetail,
  type LedgerEntry,
  type Mark,
  type NightDay,
  type RecordData,
  type RecordState,
  type RefusalRow,
  type RulebookVersion,
  type Scoreboard,
  type UniverseSymbol,
} from "./record-parse";

/**
 * The record, from wherever it lives.
 *
 * With KAAVAL_RECORD_URL set the site reads the published repository over HTTPS, which is
 * what a host with no engine beside it does. Without it the site reads the files the engine
 * is writing on this machine. Both paths parse with lib/record-parse.ts, so the two render
 * the same numbers, and every function here answers with a promise either way.
 */

export { CADENCE_MINUTES, recordPaused } from "./record-parse";
export type {
  BrainCurve,
  DecisionDetail,
  DecisionRow,
  FillRow,
  Gap,
  HaltRow,
  Intent,
  LedgerEntry,
  Mark,
  MarkPosition,
  MarkRow,
  NightDay,
  NightEvent,
  NightEventKind,
  NightLane,
  OrderRow,
  RecordData,
  RecordRead,
  RecordState,
  RefusalRow,
  RulebookVersion,
  ScoreRow,
  Scoreboard,
  Target,
  UniverseSymbol,
} from "./record-parse";

export function dataDir(): string {
  const configured = process.env.KAAVAL_DATA_DIR;
  if (configured && configured.trim() !== "") return resolve(configured);
  return resolve(process.cwd(), "..", "data", "state");
}

function ledgerDir(): string {
  return join(dataDir(), "ledger");
}

function dayFiles(): string[] {
  const dir = ledgerDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

function fileText(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * One whole read of the record from disk. The file name is the UTC date, so sorting the
 * names sorts the record by time.
 */
function diskRecord(): RecordData {
  const dir = ledgerDir();
  const names = dayFiles();
  const entries: LedgerEntry[] = [];
  for (const name of names) {
    entries.push(...parseEntries(fileText(join(dir, name)) ?? ""));
  }

  return {
    entries,
    days: names.map((name) => name.replace(/\.jsonl$/, "")),
    engine: parseJson(fileText(join(dataDir(), "engine.json"))),
    universe: parseJson(fileText(join(dataDir(), "universe.json"))),
  };
}

function published(): boolean {
  return http.recordUrl() !== null;
}

/** Every equity mark in the record, per brain, oldest first. This is the equity curve. */
export async function getMarks(): Promise<Mark[]> {
  if (published()) return http.getMarks();
  return marksOf(diskRecord());
}

/** The marks grouped into one curve per brain, in the order the brains first appear. */
export async function getCurves(): Promise<BrainCurve[]> {
  if (published()) return http.getCurves();
  return curvesOf(diskRecord());
}

/** Where each brain stands right now, from the engine's own state file. */
export async function getState(): Promise<RecordState> {
  if (published()) return http.getState();
  return stateOf(diskRecord());
}

/** The timestamp of the first entry ever written, which is when the record starts. */
export async function getFirstEntryTs(): Promise<number | null> {
  if (published()) return http.getFirstEntryTs();
  return firstEntryTsOf(diskRecord());
}

/** Tonight's tradable symbols, as the newest config entry in the ledger has them. */
export async function getUniverse(): Promise<UniverseSymbol[]> {
  if (published()) return http.getUniverse();
  return universeOf(diskRecord());
}

/** One row per brain, sorted by equity, with the gaps in the record named. */
export async function getScoreboard(now: number = Date.now()): Promise<Scoreboard> {
  if (published()) return http.getScoreboard(now);
  return scoreboardOf(diskRecord(), now);
}

/** Every refusal ever written, newest first, with the rule counts above it. */
export async function getRefusals(): Promise<{
  rows: RefusalRow[];
  byRule: Array<{ rule: string; count: number }>;
  brains: string[];
}> {
  if (published()) return http.getRefusals();
  return refusalsOf(diskRecord());
}

/** One decision and everything the rulebook and the execution layer did with it. */
export async function getDecision(seq: number): Promise<DecisionDetail | null> {
  if (published()) return http.getDecision(seq);
  return decisionOf(diskRecord(), seq);
}

/** Every config entry that carries a rulebook, oldest first, with the repeats dropped. */
export async function getRulebookHistory(): Promise<{
  current: RulebookVersion | null;
  versions: RulebookVersion[];
  repeats: number;
}> {
  if (published()) return http.getRulebookHistory();
  return rulebookHistoryOf(diskRecord());
}

/** The UTC days the ledger has a file for, oldest first. */
export async function getDays(): Promise<string[]> {
  if (published()) return http.getDays();
  return daysOf(diskRecord());
}

/** One UTC day of the record, shaped for the timeline. */
export async function getDay(day: string, now: number = Date.now()): Promise<NightDay | null> {
  if (published()) return http.getDay(day, now);
  return dayOf(diskRecord(), day, now);
}
