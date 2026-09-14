import type { LlmClient } from "./llm.js";
import { buildPrompt } from "./prompt.js";
import { DECISION_LIMITS, parseDecision } from "./schema.js";
import type { AccountView, Decision, Target, WorldState } from "./types.js";

export interface EnsembleOptions {
  runs: number;
  shrink: number;
  floorConfidence: number;
  temperature: number;
}

export interface EnsembleResult {
  targets: Target[];
  summary: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  invalidRuns: number;
}

/**
 * Enough for a rationale on every symbol in the universe with room to spare. A reply cut
 * off at the cap is a run thrown away: the first live run against Claude on 2026-09-08
 * averaged 2,700 completion tokens for two targets and lost one run of three to a 3,000
 * token cap, so the cap is set well clear of what a full answer needs.
 */
const MAX_REPLY_TOKENS = 8_000;

const NO_VALID_RUNS = "every model run came back invalid, so this brain proposes nothing this tick";

interface ValidRun {
  targets: Target[];
  summary: string;
}

/**
 * Ask the model the same question several times and combine the answers.
 *
 * One call from a language model is a sample, not a measurement. The spread across a few
 * calls is the honest signal: where the runs agree the size stands, where they disagree
 * the size shrinks and the confidence falls with it. The aggregation follows the shape
 * that works in forecasting work, adapted from probabilities to signed position sizes:
 * a trimmed mean so one wild run cannot set the size, a median confidence scaled by how
 * many runs took the same side, then a shrink toward 0.5 and a floor because models are
 * systematically overconfident about their own answers.
 *
 * Calls are sequential so runs two and three read the shared prompt from the provider's
 * cache instead of paying full price for it.
 */
export async function runEnsemble(
  client: LlmClient,
  prompt: { system: string; user: string },
  world: WorldState,
  account: AccountView,
  opts: EnsembleOptions,
): Promise<EnsembleResult> {
  const valid: ValidRun[] = [];
  let calls = 0;
  let invalidRuns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let latencyMs = 0;

  for (let i = 0; i < Math.max(1, Math.floor(opts.runs)); i += 1) {
    calls += 1;
    let text: string;
    try {
      const res = await client.complete({
        system: prompt.system,
        user: prompt.user,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: opts.temperature,
      });
      promptTokens += res.promptTokens;
      completionTokens += res.completionTokens;
      latencyMs += res.latencyMs;
      text = res.text;
    } catch {
      invalidRuns += 1;
      continue;
    }

    const parsed = parseDecision(text, world, account);
    if (!parsed.ok) {
      invalidRuns += 1;
      continue;
    }
    valid.push({ targets: parsed.targets, summary: parsed.summary });
  }

  if (valid.length === 0) {
    return {
      targets: [],
      summary: NO_VALID_RUNS,
      calls,
      promptTokens,
      completionTokens,
      latencyMs,
      invalidRuns,
    };
  }

  const targets = aggregate(valid, world, account, opts);
  return {
    targets,
    summary: closestSummary(valid, targets),
    calls,
    promptTokens,
    completionTokens,
    latencyMs,
    invalidRuns,
  };
}

/**
 * One decision from one brain: build the prompt, run the ensemble, stamp the result.
 * ClaudeBrain and QwenBrain are the same code from here down, which is the point: any
 * difference in what they decide comes from the model, never from the harness.
 */
export async function decideAsBrain(
  name: string,
  client: LlmClient,
  world: WorldState,
  account: AccountView,
  rulebookText: string,
  opts: EnsembleOptions,
): Promise<{ decision: Decision; ensemble: EnsembleResult }> {
  const prompt = buildPrompt(world, account, rulebookText);
  const ensemble = await runEnsemble(client, prompt, world, account, opts);
  return {
    decision: {
      brain: name,
      ts: Date.now(),
      targets: ensemble.targets,
      summary: ensemble.summary,
      modelCalls: ensemble.calls,
      promptTokens: ensemble.promptTokens,
      completionTokens: ensemble.completionTokens,
      latencyMs: ensemble.latencyMs,
    },
    ensemble,
  };
}

function aggregate(
  valid: ValidRun[],
  world: WorldState,
  account: AccountView,
  opts: EnsembleOptions,
): Target[] {
  const bySymbol = new Map<string, Target[]>();
  for (const run of valid) {
    for (const target of run.targets) {
      const list = bySymbol.get(target.symbol);
      if (list) list.push(target);
      else bySymbol.set(target.symbol, [target]);
    }
  }

  const bound = Math.abs(account.equity) * DECISION_LIMITS.maxNotionalShareOfEquity;
  const shrink = clamp(opts.shrink, 0, 1);
  const floor = clamp(opts.floorConfidence, 0, 1);
  const out: Target[] = [];

  for (const worldSymbol of world.symbols) {
    const proposals = bySymbol.get(worldSymbol.symbol);
    if (!proposals) continue;
    // A symbol that most runs did not name is a symbol the ensemble does not agree on.
    if (proposals.length * 2 < valid.length) continue;

    const notional = clamp(
      trimmedMean(proposals.map((p) => p.targetNotionalUsdt)),
      -bound,
      bound,
    );
    const agreement =
      proposals.filter((p) => Math.sign(p.targetNotionalUsdt) === Math.sign(notional)).length /
      proposals.length;
    const raw = median(proposals.map((p) => p.confidence)) * agreement;
    const confidence = clamp(Math.max(floor, (1 - shrink) * raw + shrink * 0.5), 0, 1);

    const closest = [...proposals].sort(
      (a, b) =>
        Math.abs(a.targetNotionalUsdt - notional) - Math.abs(b.targetNotionalUsdt - notional),
    )[0];
    if (!closest) continue;

    out.push({
      category: worldSymbol.category,
      symbol: worldSymbol.symbol,
      targetNotionalUsdt: notional,
      hedgeFor: commonHedge(proposals),
      rationale: closest.rationale,
      confidence,
      horizonMinutes: clamp(
        Math.round(median(proposals.map((p) => p.horizonMinutes))),
        DECISION_LIMITS.minHorizonMinutes,
        DECISION_LIMITS.maxHorizonMinutes,
      ),
    });
  }

  return out;
}

/** Drop the highest and lowest run once there are four to spare, then take the mean. */
function trimmedMean(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const kept = sorted.length >= 4 ? sorted.slice(1, sorted.length - 1) : sorted;
  return kept.reduce((sum, x) => sum + x, 0) / kept.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function commonHedge(proposals: Target[]): string | null {
  const counts = new Map<string, number>();
  for (const p of proposals) {
    if (p.hedgeFor) counts.set(p.hedgeFor, (counts.get(p.hedgeFor) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [symbol, count] of counts) {
    if (count > bestCount) {
      best = symbol;
      bestCount = count;
    }
  }
  return best;
}

/** The summary of the run whose sizes ended up nearest the aggregate. */
function closestSummary(valid: ValidRun[], aggregated: Target[]): string {
  const wanted = new Map(aggregated.map((t) => [t.symbol, t.targetNotionalUsdt]));
  let best = valid[0] as ValidRun;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const run of valid) {
    let distance = 0;
    for (const [symbol, notional] of wanted) {
      const match = run.targets.find((t) => t.symbol === symbol);
      distance += Math.abs((match?.targetNotionalUsdt ?? 0) - notional);
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = run;
    }
  }
  return best.summary;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
