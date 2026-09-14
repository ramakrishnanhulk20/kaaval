import type { AccountView, Target, WorldState } from "./types.js";

/**
 * The bounds a reply has to sit inside. They are not the rulebook: risk/ enforces that
 * separately and can still refuse everything here. These exist so a decision that is
 * obvious nonsense, or a decision written by a headline rather than by the model, never
 * reaches the risk layer at all.
 */
export const DECISION_LIMITS = {
  maxNotionalShareOfEquity: 0.25,
  minHorizonMinutes: 15,
  maxHorizonMinutes: 4320,
  maxRationaleChars: 600,
} as const;

export type ValidationResult =
  | { ok: true; targets: Target[]; summary: string }
  | { ok: false; reason: string };

interface RawTarget {
  category?: unknown;
  symbol?: unknown;
  targetNotionalUsdt?: unknown;
  hedgeFor?: unknown;
  rationale?: unknown;
  confidence?: unknown;
  horizonMinutes?: unknown;
}

/**
 * Read a model's reply into targets, or say why it cannot be trusted.
 *
 * One violation anywhere invalidates the whole reply. That is deliberate: a model that
 * has been pushed off the rails by a headline usually produces one bad target among
 * good ones, and salvaging the good ones would be salvaging the output of a compromised
 * run. The caller counts the run as invalid and the ensemble carries on with the rest.
 */
export function parseDecision(
  text: string,
  world: WorldState,
  account: AccountView,
): ValidationResult {
  const parsed = firstJsonObject(text);
  if (!parsed) return { ok: false, reason: "no JSON object in the reply" };

  const root = parsed as { targets?: unknown; summary?: unknown };
  if (root.targets === undefined) return { ok: false, reason: "the reply has no targets field" };
  if (!Array.isArray(root.targets)) return { ok: false, reason: "targets is not an array" };
  if (root.summary !== undefined && typeof root.summary !== "string") {
    return { ok: false, reason: "summary is not a string" };
  }

  const known = new Map(world.symbols.map((s) => [s.symbol, s]));
  const bound = Math.abs(account.equity) * DECISION_LIMITS.maxNotionalShareOfEquity;
  const targets: Target[] = [];
  const seen = new Set<string>();

  for (const entry of root.targets as RawTarget[]) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, reason: "a target is not an object" };
    }

    const symbol = entry.symbol;
    if (typeof symbol !== "string" || !known.has(symbol)) {
      return { ok: false, reason: `target names ${describe(symbol)}, which is not in this world` };
    }
    if (seen.has(symbol)) {
      return { ok: false, reason: `two targets for ${symbol}` };
    }
    seen.add(symbol);

    const worldSymbol = known.get(symbol);
    if (!worldSymbol) return { ok: false, reason: `target names ${symbol}, which is not in this world` };
    if (entry.category !== worldSymbol.category) {
      return {
        ok: false,
        reason: `${symbol} is ${worldSymbol.category}, the reply calls it ${describe(entry.category)}`,
      };
    }

    const notional = entry.targetNotionalUsdt;
    if (typeof notional !== "number" || !Number.isFinite(notional)) {
      return { ok: false, reason: `${symbol} has a target notional of ${describe(notional)}` };
    }
    if (Math.abs(notional) > bound) {
      return {
        ok: false,
        reason: `${symbol} asks for ${notional.toFixed(0)} usdt, over the ${bound.toFixed(0)} usdt bound`,
      };
    }

    const confidence = entry.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: `${symbol} has a confidence of ${describe(confidence)}` };
    }

    const horizon = entry.horizonMinutes;
    if (
      typeof horizon !== "number" ||
      !Number.isFinite(horizon) ||
      horizon < DECISION_LIMITS.minHorizonMinutes ||
      horizon > DECISION_LIMITS.maxHorizonMinutes
    ) {
      return { ok: false, reason: `${symbol} has a horizon of ${describe(horizon)} minutes` };
    }

    const rationale = entry.rationale;
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
      return { ok: false, reason: `${symbol} has no rationale` };
    }
    if (rationale.length >= DECISION_LIMITS.maxRationaleChars) {
      return {
        ok: false,
        reason: `${symbol} has a rationale of ${rationale.length} characters, the limit is ${DECISION_LIMITS.maxRationaleChars}`,
      };
    }

    const hedgeFor = entry.hedgeFor === undefined ? null : entry.hedgeFor;
    if (hedgeFor !== null && (typeof hedgeFor !== "string" || !known.has(hedgeFor))) {
      return { ok: false, reason: `${symbol} hedges ${describe(hedgeFor)}, which is not in this world` };
    }

    targets.push({
      category: worldSymbol.category,
      symbol,
      targetNotionalUsdt: notional,
      hedgeFor,
      rationale: rationale.trim(),
      confidence,
      horizonMinutes: horizon,
    });
  }

  return { ok: true, targets, summary: typeof root.summary === "string" ? root.summary.trim() : "" };
}

/**
 * The first balanced JSON object in the text.
 *
 * Braces are counted with the scanner inside and outside strings kept apart, so a brace
 * inside a rationale cannot end the object early, and text after the object (a model
 * that adds a closing sentence) is ignored rather than breaking the parse.
 */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value.slice(0, 40)}"`;
  if (value === undefined) return "nothing";
  return String(value);
}
