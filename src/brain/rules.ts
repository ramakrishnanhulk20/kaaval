import { DEFAULT_RULEBOOK, type Rulebook } from "../risk/rulebook.js";
import type { AccountView, Brain, Decision, PositionView, Target, WorldState, WorldSymbol } from "./types.js";

/**
 * How far an rToken has to sit from its own perpetual before this brain acts. Forty
 * basis points is the brain's own number, not a rulebook limit: it is wide enough to
 * clear the fees on both legs and the spread the fill model charges, so a signal that
 * fires is one that could have paid for itself.
 */
const BASIS_BAND_BPS = 40;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/**
 * The published baseline. No model, no network, no memory between ticks: it reads the
 * same world state the LLM brains get and applies two rules, basis mean reversion
 * between an rToken and its perpetual, and the weekend hedge. It exists so the record
 * can answer the only question that matters about an LLM trader: did the model beat the
 * rules it was given, or just follow them more expensively.
 */
export class RulesBrain implements Brain {
  readonly name = "rules";

  constructor(private readonly rulebook: Rulebook = DEFAULT_RULEBOOK) {}

  async decide(world: WorldState, account: AccountView, _rulebookText: string): Promise<Decision> {
    const started = Date.now();
    const rb = this.rulebook;
    const targetPct = rb.exposure.perSymbolPct - 2;
    const targetNotional = (targetPct / 100) * account.equity;
    const held = new Map(account.positions.map((p) => [key(p.category, p.symbol), p]));
    const targets: Target[] = [];
    const spoken = new Set<string>();

    const hoursShut = world.clock.regularSessionOpen ? 0 : world.clock.msToNextOpen / MS_PER_HOUR;
    const longClosure = hoursShut > rb.crossAsset.closedHoursThreshold;
    const horizon = Math.max(rb.cadence.normalMinutes, Math.round(world.clock.msToNextOpen / MS_PER_MINUTE));

    let buys = 0;
    let flats = 0;
    let hedges = 0;

    for (const rToken of world.symbols) {
      if (rToken.category !== "SPOT" || !rToken.tradable) continue;
      const perp = matchingPerp(world, rToken);
      if (!perp || perp.last <= 0) continue;

      const spotKey = key(rToken.category, rToken.symbol);
      const position = held.get(spotKey);
      const basisBps = ((rToken.last - perp.last) / perp.last) * 10_000;
      const seen = `${rToken.symbol} at ${rToken.last} against ${perp.symbol} at ${perp.last} is ${round(basisBps)} basis points ${basisBps < 0 ? "below" : "above"}`;

      if (basisBps <= -BASIS_BAND_BPS) {
        buys += 1;
        spoken.add(spotKey);
        targets.push({
          category: "SPOT",
          symbol: rToken.symbol,
          targetNotionalUsdt: targetNotional,
          hedgeFor: null,
          rationale: `${seen}, past the ${BASIS_BAND_BPS} basis point band, so hold ${round(targetNotional)} USDT, ${targetPct} percent of ${round(account.equity)} USDT equity`,
          confidence: confidenceFor(basisBps),
          horizonMinutes: horizon,
        });

        const divergence = rToken.divergencePct;
        const drifted = divergence !== null && Math.abs(divergence) > rb.crossAsset.hedgeDivergencePct;
        if (longClosure || drifted) {
          hedges += 1;
          spoken.add(key(perp.category, perp.symbol));
          const why = longClosure
            ? `the NYSE stays shut for ${round(hoursShut)} hours, over the ${rb.crossAsset.closedHoursThreshold} hour line`
            : `${rToken.symbol} has drifted ${round(divergence ?? 0)} percent from the last regular close, over the ${rb.crossAsset.hedgeDivergencePct} percent line`;
          targets.push({
            category: "USDT-FUTURES",
            symbol: perp.symbol,
            targetNotionalUsdt: -rb.crossAsset.hedgeRatio * targetNotional,
            hedgeFor: rToken.symbol,
            rationale: `${why}, so carry ${rb.crossAsset.hedgeRatio} of the ${rToken.symbol} delta short in ${perp.symbol}, ${round(rb.crossAsset.hedgeRatio * targetNotional)} USDT`,
            confidence: confidenceFor(basisBps),
            horizonMinutes: horizon,
          });
        }
      } else if (position) {
        flats += 1;
        spoken.add(spotKey);
        targets.push({
          category: "SPOT",
          symbol: rToken.symbol,
          targetNotionalUsdt: 0,
          hedgeFor: null,
          rationale: `${seen}, inside or above the ${BASIS_BAND_BPS} basis point band, so the reason for holding ${round(position.notionalUsdt)} USDT is gone`,
          confidence: confidenceFor(basisBps),
          horizonMinutes: horizon,
        });
      }
    }

    for (const position of account.positions) {
      const positionKeyText = key(position.category, position.symbol);
      if (spoken.has(positionKeyText)) continue;
      flats += 1;
      targets.push({
        category: position.category,
        symbol: position.symbol,
        targetNotionalUsdt: 0,
        hedgeFor: null,
        rationale: `no basis signal and no hedge to carry for ${position.symbol}, so close the ${round(position.notionalUsdt)} USDT ${position.side}`,
        confidence: 0.5,
        horizonMinutes: horizon,
      });
    }

    return {
      brain: this.name,
      ts: world.ts,
      targets,
      summary: `${buys} rTokens under their perpetual by more than ${BASIS_BAND_BPS} basis points, ${hedges} hedges, ${flats} closes. The NYSE is ${world.clock.regularSessionOpen ? "open" : `shut for another ${round(hoursShut)} hours`}.`,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - started,
    };
  }
}

function matchingPerp(world: WorldState, rToken: WorldSymbol): WorldSymbol | undefined {
  return world.symbols.find(
    (s) => s.category === "USDT-FUTURES" && s.underlying === rToken.underlying && s.tradable,
  );
}

function confidenceFor(basisBps: number): number {
  return Math.min(1, Math.abs(basisBps) / 100);
}

function key(category: PositionView["category"], symbol: string): string {
  return `${category}:${symbol}`;
}

function round(value: number): string {
  return value.toFixed(2);
}
