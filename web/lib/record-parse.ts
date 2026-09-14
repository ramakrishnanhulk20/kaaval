/**
 * The record, parsed. Nothing here touches the disk or the network: both data paths, the
 * files beside the engine and the published repository over HTTPS, hand these functions the
 * same raw text and get the same shapes back. That is what makes the two paths comparable.
 */

/** One tick every 15 minutes, the cadence in docs/rulebook.md. Two of them is a gap. */
export const CADENCE_MINUTES = 15;

export interface LedgerEntry {
  seq: number;
  ts: number;
  kind: string;
  account: string;
  payload: unknown;
}

export interface Mark {
  ts: number;
  brain: string;
  equity: number;
}

export interface UniverseSymbol {
  symbol: string;
  name: string;
}

export interface RecordState {
  brains: string[];
  lastTickTs: number;
  startedTs: number;
  halted: string[];
  balanceUsdt: number | null;
}

export interface BrainCurve {
  brain: string;
  points: Array<{ ts: number; equity: number }>;
}

/** One whole read of the record: every entry, the day names, the engine state, the universe. */
export interface RecordData {
  entries: LedgerEntry[];
  days: string[];
  engine: unknown;
  universe: unknown;
}

/**
 * Every entry in one day file, oldest first. A line that will not parse is skipped rather
 * than thrown, because the engine appends to today's file while this runs and the last line
 * can be half written.
 */
export function parseEntries(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

export function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Every equity mark in the record, per brain, oldest first. This is the equity curve. */
export function marksOf(data: RecordData): Mark[] {
  const marks: Mark[] = [];
  for (const entry of data.entries) {
    if (entry.kind !== "mark") continue;
    if (!isRecord(entry.payload)) continue;
    const equity = numberOf(entry.payload["equity"]);
    if (equity === null) continue;
    marks.push({ ts: entry.ts, brain: entry.account, equity });
  }
  marks.sort((a, b) => a.ts - b.ts);
  return marks;
}

/** The marks grouped into one curve per brain, in the order the brains first appear. */
export function curvesOf(data: RecordData): BrainCurve[] {
  const curves = new Map<string, BrainCurve>();
  for (const mark of marksOf(data)) {
    const curve = curves.get(mark.brain) ?? { brain: mark.brain, points: [] };
    curve.points.push({ ts: mark.ts, equity: mark.equity });
    curves.set(mark.brain, curve);
  }
  return [...curves.values()];
}

/** The timestamp of the first entry ever written, which is when the record starts. */
export function firstEntryTsOf(data: RecordData): number | null {
  return data.entries[0]?.ts ?? null;
}

/** The newest config entry, which carries the brains, the universe and the starting balance. */
function newestConfig(data: RecordData): Record<string, unknown> | null {
  let newest: Record<string, unknown> | null = null;
  for (const entry of data.entries) {
    if (entry.kind !== "config") continue;
    // The daily universe refresh and the dry-run preview note are also config entries; only
    // the run config names the brains and carries the starting balance.
    if (isRecord(entry.payload) && Array.isArray(entry.payload["brains"])) newest = entry.payload;
  }
  return newest;
}

/**
 * Where each brain stands right now, from the engine's own state file. Falls back to the
 * newest config entry for the brain list when the engine has not written state yet.
 */
export function stateOf(data: RecordData): RecordState {
  const config = newestConfig(data);
  const configBrains = Array.isArray(config?.["brains"])
    ? (config["brains"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const balanceUsdt = config ? numberOf(config["balanceUsdt"]) : null;

  const parsed = data.engine;
  if (!isRecord(parsed)) {
    return { brains: configBrains, lastTickTs: 0, startedTs: 0, halted: [], balanceUsdt };
  }

  const brainsField = parsed["brains"];
  const brains: string[] = [];
  const halted: string[] = [];
  if (isRecord(brainsField)) {
    for (const [name, brain] of Object.entries(brainsField)) {
      brains.push(name);
      if (isRecord(brain) && brain["halted"] === true) halted.push(name);
    }
  }

  return {
    brains: brains.length > 0 ? brains : configBrains,
    lastTickTs: numberOf(parsed["lastTickTs"]) ?? 0,
    startedTs: numberOf(parsed["startedTs"]) ?? 0,
    halted,
    balanceUsdt,
  };
}

/**
 * Tonight's tradable symbols. The newest config entry decides which symbols are in force,
 * because that is the list the ledger was written under. universe.json is read only for
 * the exchange's own name for each one, and a symbol missing from it falls back to a name
 * derived from the symbol itself.
 */
export function universeOf(data: RecordData): UniverseSymbol[] {
  const config = newestConfig(data);
  const symbols = Array.isArray(config?.["universe"])
    ? (config["universe"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const names = new Map<string, string>();
  const parsed = data.universe;
  const entries = isRecord(parsed) && Array.isArray(parsed["entries"]) ? parsed["entries"] : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const rToken = entry["rToken"];
    if (!isRecord(rToken)) continue;
    const symbol = rToken["symbol"];
    const baseCoin = rToken["baseCoin"];
    if (typeof symbol === "string" && typeof baseCoin === "string") names.set(symbol, baseCoin);
  }

  return symbols.map((symbol) => ({ symbol, name: names.get(symbol) ?? derivedName(symbol) }));
}

/** RNVDAUSDT is the rToken for NVDA, so the readable name is rNVDA. */
function derivedName(symbol: string): string {
  const stripped = symbol.replace(/^R/, "").replace(/USDT$/, "");
  return stripped === "" ? symbol : `r${stripped}`;
}

/** True when the newest tick is older than two cadences, which is a gap worth naming. */
export function recordPaused(lastTickTs: number, now: number = Date.now()): boolean {
  if (lastTickTs <= 0) return true;
  return now - lastTickTs > CADENCE_MINUTES * 2 * 60_000;
}

/* ---------------------------------------------------------------------------
 * Reading the rest of the record. Every shape below is a payload the engine
 * writes in src/ledger/ledger.ts, read defensively: a field an older entry was
 * written without comes back null instead of throwing.
 * ------------------------------------------------------------------------- */

export interface Intent {
  category: string;
  symbol: string;
  side: string;
  notionalUsdt: number | null;
  reduceOnly: boolean;
  hedgeFor: string | null;
  brain: string;
  source: string;
}

export interface Target {
  category: string;
  symbol: string;
  targetNotionalUsdt: number | null;
  hedgeFor: string | null;
  rationale: string;
  confidence: number | null;
  horizonMinutes: number | null;
}

export interface DecisionRow {
  seq: number;
  ts: number;
  brain: string;
  summary: string;
  targets: Target[];
  modelCalls: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface RefusalRow {
  seq: number;
  ts: number;
  brain: string;
  rule: string;
  reason: string;
  intent: Intent | null;
  decisionSeq: number | null;
}

export interface OrderRow {
  seq: number;
  ts: number;
  brain: string;
  orderId: string;
  symbol: string;
  category: string;
  side: string;
  type: string;
  qty: number | null;
  limitPrice: number | null;
  reduceOnly: boolean;
  source: string;
  notes: string[];
  agentHubRequest: unknown;
  stopRequest: unknown;
  decisionSeq: number | null;
}

export interface FillRow {
  seq: number;
  ts: number;
  brain: string;
  orderId: string;
  symbol: string;
  category: string;
  side: string;
  source: string;
  qty: number | null;
  avgPrice: number | null;
  notionalUsdt: number | null;
  feeUsdt: number | null;
  slippageBps: number | null;
  levelsConsumed: number | null;
  partial: boolean;
  demo: boolean;
  bookHash: string;
  decisionSeq: number | null;
}

export interface MarkPosition {
  category: string;
  symbol: string;
  side: string;
  qty: number | null;
  avgEntry: number | null;
  mark: number | null;
  notionalUsdt: number | null;
  unrealised: number | null;
  markSource: string | null;
}

export interface MarkRow {
  seq: number;
  ts: number;
  brain: string;
  equity: number;
  balance: number | null;
  realised: number | null;
  unrealised: number | null;
  drawdownPct: number | null;
  dayPnlPct: number | null;
  positions: MarkPosition[];
}

export interface HaltRow {
  seq: number;
  ts: number;
  brain: string;
  active: boolean;
  source: string;
  note: string;
  drawdownPct: number | null;
  flattened: Array<{ category: string; symbol: string; side: string; notionalUsdt: number | null }>;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function payloadOf(entry: LedgerEntry): Record<string, unknown> | null {
  return isRecord(entry.payload) ? entry.payload : null;
}

function toIntent(value: unknown): Intent | null {
  if (!isRecord(value)) return null;
  return {
    category: stringOf(value["category"]) ?? "",
    symbol: stringOf(value["symbol"]) ?? "",
    side: stringOf(value["side"]) ?? "",
    notionalUsdt: numberOf(value["notionalUsdt"]),
    reduceOnly: value["reduceOnly"] === true,
    hedgeFor: stringOf(value["hedgeFor"]),
    brain: stringOf(value["brain"]) ?? "",
    source: stringOf(value["source"]) ?? "",
  };
}

function toTargets(value: unknown): Target[] {
  if (!Array.isArray(value)) return [];
  const targets: Target[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    targets.push({
      category: stringOf(item["category"]) ?? "",
      symbol: stringOf(item["symbol"]) ?? "",
      targetNotionalUsdt: numberOf(item["targetNotionalUsdt"]),
      hedgeFor: stringOf(item["hedgeFor"]),
      rationale: stringOf(item["rationale"]) ?? "",
      confidence: numberOf(item["confidence"]),
      horizonMinutes: numberOf(item["horizonMinutes"]),
    });
  }
  return targets;
}

function toPositions(value: unknown): MarkPosition[] {
  if (!Array.isArray(value)) return [];
  const positions: MarkPosition[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    positions.push({
      category: stringOf(item["category"]) ?? "",
      symbol: stringOf(item["symbol"]) ?? "",
      side: stringOf(item["side"]) ?? "",
      qty: numberOf(item["qty"]),
      avgEntry: numberOf(item["avgEntry"]),
      mark: numberOf(item["mark"]),
      notionalUsdt: numberOf(item["notionalUsdt"]),
      unrealised: numberOf(item["unrealised"]),
      markSource: stringOf(item["markSource"]),
    });
  }
  return positions;
}

function toDecision(entry: LedgerEntry): DecisionRow | null {
  const payload = payloadOf(entry);
  if (!payload) return null;
  return {
    seq: entry.seq,
    ts: entry.ts,
    brain: entry.account,
    summary: stringOf(payload["summary"]) ?? "",
    targets: toTargets(payload["targets"]),
    modelCalls: numberOf(payload["modelCalls"]),
    promptTokens: numberOf(payload["promptTokens"]),
    completionTokens: numberOf(payload["completionTokens"]),
    latencyMs: numberOf(payload["latencyMs"]),
    error: stringOf(payload["error"]),
  };
}

/** The decision the brain was working under when a later entry was written. */
function decisionSeqBefore(entries: LedgerEntry[], index: number, brain: string): number | null {
  for (let back = index - 1; back >= 0; back -= 1) {
    const entry = entries[back];
    if (!entry) continue;
    if (entry.kind === "decision" && entry.account === brain) return entry.seq;
  }
  return null;
}

export interface RecordRead {
  entries: LedgerEntry[];
  decisions: DecisionRow[];
  refusals: RefusalRow[];
  orders: OrderRow[];
  fills: FillRow[];
  marks: MarkRow[];
  halts: HaltRow[];
}

/** One typed pass over a list of entries. Every page below reads from this. */
export function readRecord(entries: LedgerEntry[]): RecordRead {
  const read: RecordRead = {
    entries,
    decisions: [],
    refusals: [],
    orders: [],
    fills: [],
    marks: [],
    halts: [],
  };

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const payload = payloadOf(entry);
    if (!payload) continue;

    if (entry.kind === "decision") {
      const decision = toDecision(entry);
      if (decision) read.decisions.push(decision);
      continue;
    }

    if (entry.kind === "reject") {
      read.refusals.push({
        seq: entry.seq,
        ts: entry.ts,
        brain: entry.account,
        rule: stringOf(payload["rule"]) ?? "unnamed rule",
        reason: stringOf(payload["reason"]) ?? "",
        intent: toIntent(payload["intent"]),
        decisionSeq: decisionSeqBefore(entries, index, entry.account),
      });
      continue;
    }

    if (entry.kind === "order") {
      const order = isRecord(payload["order"]) ? payload["order"] : {};
      const notes = Array.isArray(payload["notes"])
        ? payload["notes"].filter((note): note is string => typeof note === "string")
        : [];
      read.orders.push({
        seq: entry.seq,
        ts: entry.ts,
        brain: entry.account,
        orderId: stringOf(order["id"]) ?? "",
        symbol: stringOf(order["symbol"]) ?? "",
        category: stringOf(order["category"]) ?? "",
        side: stringOf(order["side"]) ?? "",
        type: stringOf(order["type"]) ?? "",
        qty: numberOf(order["qty"]),
        limitPrice: numberOf(order["limitPrice"]),
        reduceOnly: order["reduceOnly"] === true,
        source: stringOf(order["source"]) ?? "",
        notes,
        agentHubRequest: payload["agentHubRequest"] ?? null,
        stopRequest: payload["stopRequest"] ?? null,
        decisionSeq: decisionSeqBefore(entries, index, entry.account),
      });
      continue;
    }

    if (entry.kind === "fill") {
      const order = isRecord(payload["order"]) ? payload["order"] : {};
      const fill = isRecord(payload["fill"]) ? payload["fill"] : {};
      read.fills.push({
        seq: entry.seq,
        ts: entry.ts,
        brain: entry.account,
        orderId: stringOf(fill["orderId"]) ?? stringOf(order["id"]) ?? "",
        symbol: stringOf(fill["symbol"]) ?? stringOf(order["symbol"]) ?? "",
        category: stringOf(fill["category"]) ?? stringOf(order["category"]) ?? "",
        side: stringOf(fill["side"]) ?? stringOf(order["side"]) ?? "",
        source: stringOf(order["source"]) ?? "",
        qty: numberOf(fill["qty"]),
        avgPrice: numberOf(fill["avgPrice"]),
        notionalUsdt: numberOf(fill["notionalUsdt"]),
        feeUsdt: numberOf(fill["feeUsdt"]),
        slippageBps: numberOf(fill["slippageBps"]),
        levelsConsumed: numberOf(fill["levelsConsumed"]),
        partial: fill["partial"] === true,
        demo: payload["demo"] === true,
        bookHash: stringOf(fill["bookHash"]) ?? "",
        decisionSeq: decisionSeqBefore(entries, index, entry.account),
      });
      continue;
    }

    if (entry.kind === "mark") {
      const equity = numberOf(payload["equity"]);
      if (equity === null) continue;
      read.marks.push({
        seq: entry.seq,
        ts: entry.ts,
        brain: entry.account,
        equity,
        balance: numberOf(payload["balance"]),
        realised: numberOf(payload["realised"]),
        unrealised: numberOf(payload["unrealised"]),
        drawdownPct: numberOf(payload["drawdownPct"]),
        dayPnlPct: numberOf(payload["dayPnlPct"]),
        positions: toPositions(payload["positions"]),
      });
      continue;
    }

    if (entry.kind === "halt") {
      const flattened: HaltRow["flattened"] = [];
      if (Array.isArray(payload["flattened"])) {
        for (const item of payload["flattened"]) {
          if (!isRecord(item)) continue;
          flattened.push({
            category: stringOf(item["category"]) ?? "",
            symbol: stringOf(item["symbol"]) ?? "",
            side: stringOf(item["side"]) ?? "",
            notionalUsdt: numberOf(item["notionalUsdt"]),
          });
        }
      }
      read.halts.push({
        seq: entry.seq,
        ts: entry.ts,
        brain: entry.account,
        active: payload["active"] === true,
        source: stringOf(payload["source"]) ?? "",
        note: stringOf(payload["note"]) ?? "",
        drawdownPct: numberOf(payload["drawdownPct"]),
        flattened,
      });
    }
  }

  return read;
}

export interface Gap {
  from: number;
  to: number;
  ms: number;
}

/** A stretch longer than two cadences with no tick in it. The hero draws these too. */
function gapsIn(times: number[], now: number, lastTickTs: number): Gap[] {
  const gapMs = CADENCE_MINUTES * 2 * 60_000;
  const gaps: Gap[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const from = times[index - 1];
    const to = times[index];
    if (from === undefined || to === undefined) continue;
    if (to - from > gapMs) gaps.push({ from, to, ms: to - from });
  }
  if (lastTickTs > 0 && now - lastTickTs > gapMs) {
    gaps.push({ from: lastTickTs, to: now, ms: now - lastTickTs });
  }
  return gaps;
}

export interface ScoreRow {
  brain: string;
  baseline: boolean;
  halted: boolean;
  equity: number | null;
  dayPnlPct: number | null;
  totalReturnPct: number | null;
  realised: number | null;
  unrealised: number | null;
  drawdownPct: number | null;
  positions: MarkPosition[];
  fills: number;
  refusals: number;
  marks: number;
  lastDecision: { seq: number; ts: number; summary: string; error: string | null } | null;
  curve: Array<{ ts: number; equity: number }>;
}

export interface Scoreboard {
  rows: ScoreRow[];
  startEquity: number | null;
  startedTs: number | null;
  lastTickTs: number;
  gaps: Gap[];
  entries: number;
  fills: number;
  refusals: number;
}

/**
 * One row per brain, sorted by equity. Everything here is the newest mark entry for that
 * brain plus counts over the whole record; the halted flag is the engine state file,
 * because a halt that fired between two marks is true now and the mark cannot know it.
 */
export function scoreboardOf(data: RecordData, now: number = Date.now()): Scoreboard {
  const record = readRecord(data.entries);
  const state = stateOf(data);

  const names = new Set<string>(state.brains);
  for (const mark of record.marks) names.add(mark.brain);

  const rows: ScoreRow[] = [];
  for (const brain of names) {
    const marks = record.marks.filter((mark) => mark.brain === brain);
    const last = marks.at(-1) ?? null;
    const decisions = record.decisions.filter((decision) => decision.brain === brain);
    const lastDecision = decisions.at(-1) ?? null;
    const start = state.balanceUsdt;
    rows.push({
      brain,
      baseline: brain === "rules",
      halted: state.halted.includes(brain),
      equity: last?.equity ?? null,
      dayPnlPct: last?.dayPnlPct ?? null,
      totalReturnPct:
        last && start !== null && start > 0 ? ((last.equity - start) / start) * 100 : null,
      realised: last?.realised ?? null,
      unrealised: last?.unrealised ?? null,
      drawdownPct: last?.drawdownPct ?? null,
      positions: last?.positions ?? [],
      fills: record.fills.filter((fill) => fill.brain === brain).length,
      refusals: record.refusals.filter((refusal) => refusal.brain === brain).length,
      marks: marks.length,
      lastDecision: lastDecision
        ? {
            seq: lastDecision.seq,
            ts: lastDecision.ts,
            summary: lastDecision.summary,
            error: lastDecision.error,
          }
        : null,
      curve: marks.map((mark) => ({ ts: mark.ts, equity: mark.equity })),
    });
  }

  rows.sort((a, b) => (b.equity ?? -Infinity) - (a.equity ?? -Infinity));

  const tickTimes = [...new Set(record.marks.map((mark) => mark.ts))].sort((a, b) => a - b);

  return {
    rows,
    startEquity: state.balanceUsdt,
    startedTs: firstEntryTsOf(data),
    lastTickTs: state.lastTickTs,
    gaps: gapsIn(tickTimes, now, state.lastTickTs),
    entries: record.entries.length,
    fills: record.fills.length,
    refusals: record.refusals.length,
  };
}

/** Every refusal ever written, newest first, with the rule counts above it. */
export function refusalsOf(data: RecordData): {
  rows: RefusalRow[];
  byRule: Array<{ rule: string; count: number }>;
  brains: string[];
} {
  const record = readRecord(data.entries);
  const rows = [...record.refusals].sort((a, b) => b.seq - a.seq);

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.rule, (counts.get(row.rule) ?? 0) + 1);
  const byRule = [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));

  const brains = [...new Set(rows.map((row) => row.brain))].sort();
  return { rows, byRule, brains };
}

export interface DecisionDetail {
  decision: DecisionRow;
  verdicts: Array<{
    target: Target;
    refusals: RefusalRow[];
    orders: OrderRow[];
    fills: FillRow[];
  }>;
  refusals: RefusalRow[];
  orders: OrderRow[];
  fills: FillRow[];
  previousSeq: number | null;
  nextSeq: number | null;
}

/**
 * One decision and everything the rulebook and the execution layer did with it: the window
 * runs from this entry to the next decision the same brain wrote, which is exactly the
 * stretch of the record that this decision is answerable for.
 */
export function decisionOf(data: RecordData, seq: number): DecisionDetail | null {
  const record = readRecord(data.entries);
  const index = record.decisions.findIndex((decision) => decision.seq === seq);
  if (index < 0) return null;
  const decision = record.decisions[index];
  if (!decision) return null;

  const sameBrain = record.decisions.filter((item) => item.brain === decision.brain);
  const position = sameBrain.findIndex((item) => item.seq === decision.seq);
  const nextOfBrain = sameBrain[position + 1]?.seq ?? Infinity;

  const within = <T extends { seq: number }>(rows: T[]): T[] =>
    rows.filter((row) => row.seq > decision.seq && row.seq < nextOfBrain);

  const refusals = within(record.refusals.filter((row) => row.brain === decision.brain));
  const orders = within(record.orders.filter((row) => row.brain === decision.brain));
  const fills = within(record.fills.filter((row) => row.brain === decision.brain));

  const verdicts = decision.targets.map((target) => ({
    target,
    refusals: refusals.filter((row) => row.intent?.symbol === target.symbol),
    orders: orders.filter((row) => row.symbol === target.symbol),
    fills: fills.filter((row) => row.symbol === target.symbol),
  }));

  return {
    decision,
    verdicts,
    refusals,
    orders,
    fills,
    previousSeq: record.decisions[index - 1]?.seq ?? null,
    nextSeq: record.decisions[index + 1]?.seq ?? null,
  };
}

export interface RulebookVersion {
  seq: number;
  ts: number;
  text: string;
  note: string | null;
  universe: string[];
  brains: string[];
  publicKeyHex: string | null;
}

/** Every config entry that carries a rulebook, oldest first, with the unchanged ones dropped. */
export function rulebookHistoryOf(data: RecordData): {
  current: RulebookVersion | null;
  versions: RulebookVersion[];
  repeats: number;
} {
  const versions: RulebookVersion[] = [];
  let repeats = 0;
  let previous: string | null = null;

  for (const entry of data.entries) {
    if (entry.kind !== "config") continue;
    const payload = payloadOf(entry);
    if (!payload) continue;
    const text = stringOf(payload["rulebook"]);
    if (text === null) continue;
    if (text === previous) {
      repeats += 1;
      continue;
    }
    previous = text;
    versions.push({
      seq: entry.seq,
      ts: entry.ts,
      text,
      note: stringOf(payload["note"]),
      universe: Array.isArray(payload["universe"])
        ? payload["universe"].filter((symbol): symbol is string => typeof symbol === "string")
        : [],
      brains: Array.isArray(payload["brains"])
        ? payload["brains"].filter((brain): brain is string => typeof brain === "string")
        : [],
      publicKeyHex: stringOf(payload["publicKeyHex"]),
    });
  }

  return { current: versions.at(-1) ?? null, versions, repeats };
}

export type NightEventKind = "decision" | "fill" | "refusal" | "halt" | "stop";

export interface NightEvent {
  id: string;
  seq: number;
  ts: number;
  brain: string;
  kind: NightEventKind;
  /** The mono heading in the side panel. */
  title: string;
  /** One line, shown under the heading. */
  line: string;
  /** Label and value pairs, in the order they should be read. */
  fields: Array<[string, string]>;
  /** The long text: a summary, a reason, or a note. */
  body: string | null;
  /** The per target rationale, in the words the brain wrote. */
  notes: Array<[string, string]>;
  decisionSeq: number | null;
  /** True when this event is drawn as a rule across every lane rather than on one. */
  full: boolean;
}

export interface NightLane {
  brain: string;
  baseline: boolean;
  points: Array<{ ts: number; equity: number }>;
  low: number;
  high: number;
}

export interface NightDay {
  day: string;
  days: string[];
  startTs: number;
  endTs: number;
  lanes: NightLane[];
  events: NightEvent[];
  counts: Record<NightEventKind, number>;
  entries: number;
}

/** The UTC days the ledger has a file for, oldest first. */
export function daysOf(data: RecordData): string[] {
  return data.days;
}

function usdt(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)} USDT`;
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

/**
 * One UTC day of the record, shaped for the timeline: a lane per brain with its equity
 * marks, and every decision, fill, refusal, stop and halt as an event on the clock.
 */
export function dayOf(data: RecordData, day: string, now: number = Date.now()): NightDay | null {
  const days = daysOf(data);
  if (!days.includes(day)) return null;

  const entries = data.entries.filter(
    (entry) => new Date(entry.ts).toISOString().slice(0, 10) === day,
  );
  const record = readRecord(entries);

  const startTs = Date.parse(`${day}T00:00:00.000Z`);
  // A day still being written ends at the clock, not at midnight, so the playhead does not
  // spend most of its travel on hours that have not happened yet.
  const lastTs = entries.at(-1)?.ts ?? startTs;
  const endTs = Math.min(startTs + 24 * 60 * 60_000, Math.max(now, lastTs + 60_000));

  const laneNames = [...new Set(record.marks.map((mark) => mark.brain))].sort();
  const lanes: NightLane[] = laneNames.map((brain) => {
    const points = record.marks
      .filter((mark) => mark.brain === brain)
      .map((mark) => ({ ts: mark.ts, equity: mark.equity }));
    const values = points.map((point) => point.equity);
    return {
      brain,
      baseline: brain === "rules",
      points,
      low: values.length > 0 ? Math.min(...values) : 0,
      high: values.length > 0 ? Math.max(...values) : 0,
    };
  });

  const events: NightEvent[] = [];

  for (const decision of record.decisions) {
    const targets = decision.targets.length;
    events.push({
      id: `d-${String(decision.seq)}`,
      seq: decision.seq,
      ts: decision.ts,
      brain: decision.brain,
      kind: "decision",
      title: decision.error === null ? "decision" : "decision failed",
      line:
        targets === 0
          ? "no targets"
          : `${String(targets)} ${targets === 1 ? "target" : "targets"}: ${decision.targets
              .map((target) => target.symbol)
              .join(", ")}`,
      fields: [
        ["model calls", decision.modelCalls === null ? "n/a" : String(decision.modelCalls)],
        [
          "tokens",
          decision.promptTokens === null && decision.completionTokens === null
            ? "n/a"
            : `${String(decision.promptTokens ?? 0)} in, ${String(decision.completionTokens ?? 0)} out`,
        ],
        [
          "latency",
          decision.latencyMs === null ? "n/a" : `${(decision.latencyMs / 1000).toFixed(1)}s`,
        ],
        ...(decision.error === null
          ? []
          : ([["error", decision.error]] as Array<[string, string]>)),
      ],
      body: decision.summary,
      notes: decision.targets.map((target) => [
        `${target.symbol} ${
          target.targetNotionalUsdt === null ? "" : `${target.targetNotionalUsdt.toFixed(0)} USDT `
        }${target.confidence === null ? "" : `confidence ${target.confidence.toFixed(2)} `}${
          target.horizonMinutes === null ? "" : `over ${String(target.horizonMinutes)} minutes`
        }`.trim(),
        target.rationale,
      ]),
      decisionSeq: decision.seq,
      full: false,
    });
  }

  for (const fill of record.fills) {
    events.push({
      id: `f-${String(fill.seq)}`,
      seq: fill.seq,
      ts: fill.ts,
      brain: fill.brain,
      kind: fill.source === "stop" || fill.source === "kill" ? "stop" : "fill",
      title: `${fill.side} ${fill.symbol}`,
      line: `${fill.qty === null ? "n/a" : String(fill.qty)} at ${
        fill.avgPrice === null ? "n/a" : fill.avgPrice.toFixed(4)
      }`,
      fields: [
        ["notional", usdt(fill.notionalUsdt)],
        ["fee", usdt(fill.feeUsdt)],
        [
          "slippage",
          fill.slippageBps === null ? "n/a" : `${fill.slippageBps.toFixed(2)} bps`,
        ],
        ["levels", fill.levelsConsumed === null ? "n/a" : String(fill.levelsConsumed)],
        ["book", fill.bookHash === "" ? "n/a" : fill.bookHash],
        ["filled by", fill.demo ? "Bitget demo environment" : "the simulator, on the recorded book"],
        ["source", fill.source === "" ? "brain" : fill.source],
      ],
      body: null,
      notes: [],
      decisionSeq: fill.decisionSeq,
      full: fill.source === "stop" || fill.source === "kill",
    });
  }

  for (const refusal of record.refusals) {
    events.push({
      id: `r-${String(refusal.seq)}`,
      seq: refusal.seq,
      ts: refusal.ts,
      brain: refusal.brain,
      kind: "refusal",
      title: `refused ${refusal.intent?.symbol ?? ""}`.trim(),
      line: refusal.rule,
      fields: [
        ["rule", refusal.rule],
        ["side", refusal.intent?.side ?? "n/a"],
        ["size asked", usdt(refusal.intent?.notionalUsdt ?? null)],
        ["reduce only", refusal.intent?.reduceOnly === true ? "yes" : "no"],
      ],
      body: refusal.reason,
      notes: [],
      decisionSeq: refusal.decisionSeq,
      full: false,
    });
  }

  for (const halt of record.halts) {
    events.push({
      id: `h-${String(halt.seq)}`,
      seq: halt.seq,
      ts: halt.ts,
      brain: halt.brain,
      kind: "halt",
      title: halt.active ? "halt on" : "halt off",
      line: halt.source,
      fields: [
        ["drawdown", pct(halt.drawdownPct)],
        ["flattened", halt.flattened.length === 0 ? "nothing" : String(halt.flattened.length)],
        ...halt.flattened.map(
          (position) =>
            [`${position.side} ${position.symbol}`, usdt(position.notionalUsdt)] as [string, string],
        ),
      ],
      body: halt.note,
      notes: [],
      decisionSeq: null,
      full: true,
    });
  }

  events.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const counts: Record<NightEventKind, number> = {
    decision: 0,
    fill: 0,
    refusal: 0,
    halt: 0,
    stop: 0,
  };
  for (const event of events) counts[event.kind] += 1;

  return { day, days, startTs, endTs, lanes, events, counts, entries: entries.length };
}
