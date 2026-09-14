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
 * The record read over HTTPS, from the published repository rather than from the disk
 * beside the engine. This is the path the hosted site takes: every file is a static file
 * on a plain URL, so a judge can open the same URL and see the same bytes.
 *
 * The parsing is not repeated here. Both paths hand the text to lib/record-parse.ts.
 */

/** One tick every 15 minutes, so a minute of cache is never a minute wrong. */
const REVALIDATE_SECONDS = 60;

/** The base of the published record, with no trailing slash. Null means read the disk. */
export function recordUrl(): string | null {
  const configured = process.env.KAAVAL_RECORD_URL;
  if (configured === undefined || configured.trim() === "") return null;
  return configured.trim().replace(/\/+$/, "");
}

function base(): string {
  const url = recordUrl();
  if (url === null) throw new Error("KAAVAL_RECORD_URL is not set, so there is nothing to fetch.");
  return url;
}

async function fetchText(path: string): Promise<string | null> {
  const response = await fetch(`${base()}/${path}`, { next: { revalidate: REVALIDATE_SECONDS } });
  if (!response.ok) return null;
  return response.text();
}

interface Manifest {
  ledgerFiles: Array<{ name: string }>;
}

function manifestOf(text: string | null): Manifest {
  const parsed = parseJson(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`The published record at ${base()} has no readable manifest.`);
  }
  const files = (parsed as Record<string, unknown>)["ledgerFiles"];
  if (!Array.isArray(files)) return { ledgerFiles: [] };
  const named: Array<{ name: string }> = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const name = (file as Record<string, unknown>)["name"];
    if (typeof name === "string") named.push({ name });
  }
  return { ledgerFiles: named };
}

/**
 * One whole read of the published record. The manifest names the day files, so a new day
 * needs no code change and no directory listing, which a static host does not offer.
 */
export async function loadRecord(): Promise<RecordData> {
  const manifest = manifestOf(await fetchText("kaaval/manifest.json"));
  const names = manifest.ledgerFiles.map((file) => file.name).sort();

  const [days, engineText, universeText] = await Promise.all([
    Promise.all(names.map((name) => fetchText(`kaaval/ledger/${name}`))),
    fetchText("kaaval/state/engine.json"),
    fetchText("kaaval/state/universe.json"),
  ]);

  const entries: LedgerEntry[] = [];
  for (const text of days) {
    if (text === null) continue;
    entries.push(...parseEntries(text));
  }

  return {
    entries,
    days: names.map((name) => name.replace(/\.jsonl$/, "")),
    engine: parseJson(engineText),
    // A record published before the universe was on the allowlist has no such file, and
    // the reader falls back to a name derived from the symbol rather than failing.
    universe: parseJson(universeText),
  };
}

export async function getMarks(): Promise<Mark[]> {
  return marksOf(await loadRecord());
}

export async function getCurves(): Promise<BrainCurve[]> {
  return curvesOf(await loadRecord());
}

export async function getState(): Promise<RecordState> {
  return stateOf(await loadRecord());
}

export async function getFirstEntryTs(): Promise<number | null> {
  return firstEntryTsOf(await loadRecord());
}

export async function getUniverse(): Promise<UniverseSymbol[]> {
  return universeOf(await loadRecord());
}

export async function getScoreboard(now: number = Date.now()): Promise<Scoreboard> {
  return scoreboardOf(await loadRecord(), now);
}

export async function getRefusals(): Promise<{
  rows: RefusalRow[];
  byRule: Array<{ rule: string; count: number }>;
  brains: string[];
}> {
  return refusalsOf(await loadRecord());
}

export async function getDecision(seq: number): Promise<DecisionDetail | null> {
  return decisionOf(await loadRecord(), seq);
}

export async function getRulebookHistory(): Promise<{
  current: RulebookVersion | null;
  versions: RulebookVersion[];
  repeats: number;
}> {
  return rulebookHistoryOf(await loadRecord());
}

export async function getDays(): Promise<string[]> {
  return daysOf(await loadRecord());
}

export async function getDay(day: string, now: number = Date.now()): Promise<NightDay | null> {
  return dayOf(await loadRecord(), day, now);
}

/** The stored proof run, as the publisher copied it. Null when the host cannot fetch it. */
export async function fetchProof(): Promise<unknown> {
  return parseJson(await fetchText("kaaval/proof/latest.json"));
}

/** The published trade log, streamed through untouched. Null when it is not there yet. */
export async function fetchTradesCsv(): Promise<Response | null> {
  const response = await fetch(`${base()}/kaaval/trades.csv`, {
    next: { revalidate: REVALIDATE_SECONDS },
  });
  if (!response.ok) return null;
  return response;
}
