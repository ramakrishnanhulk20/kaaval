// The Qwen brain with a fake client, and the check that matters most for the record: on
// the same world and the same replies it produces the same decision as the Claude brain,
// so any published difference between the two comes from the model. Does NOT cover: the
// live Bitget Qwen proxy (npm run proof:brains runs it when a key is set) or the wire
// shape, which test/brain/llm.test.ts owns.
import { describe, expect, it } from "vitest";
import { ClaudeBrain } from "../../src/brain/claude.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../src/brain/llm.js";
import { QwenBrain } from "../../src/brain/qwen.js";
import type { AccountView, WorldState } from "../../src/brain/types.js";

const RULEBOOK = "Per symbol: 10 percent of equity. Gross: 60 percent.";

const ACCOUNT: AccountView = {
  id: "kaaval-qwen",
  equity: 10_000,
  balanceUsdt: 10_000,
  realisedPnl: 0,
  unrealised: 0,
  drawdownPct: 0,
  dayPnlPct: 0,
  positions: [],
};

const WORLD: WorldState = {
  ts: Date.parse("2026-09-08T02:00:00Z"),
  clock: {
    nowEt: "2026-09-07 22:00:00 ET",
    regularSessionOpen: false,
    isWeekend: false,
    msToNextOpen: 41_400_000,
    msToNextClose: 64_800_000,
  },
  window: "normal",
  symbols: [
    {
      category: "SPOT",
      symbol: "RTSLAUSDT",
      underlying: "TSLA",
      last: 412.5,
      bid: 412.4,
      ask: 412.6,
      spreadBps: 4.8,
      volume24hUsdt: 1_250_000,
      divergencePct: 1.2,
      fundingRate: null,
      openInterest: null,
      roundTheClock: true,
      tradable: true,
    },
    {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      underlying: "TSLA",
      last: 411.9,
      bid: 411.8,
      ask: 412,
      spreadBps: 4.9,
      volume24hUsdt: 9_400_000,
      divergencePct: 1.05,
      fundingRate: 0.0001,
      openInterest: 120_000,
      roundTheClock: true,
      tradable: true,
    },
  ],
  news: [],
  calendar: [],
};

const REPLY = JSON.stringify({
  summary: "long the rToken, hedge it in the perp",
  targets: [
    {
      category: "SPOT",
      symbol: "RTSLAUSDT",
      targetNotionalUsdt: 900,
      hedgeFor: null,
      rationale: "divergence of 1.2 percent with the New York session shut",
      confidence: 0.55,
      horizonMinutes: 480,
    },
    {
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      targetNotionalUsdt: -500,
      hedgeFor: "RTSLAUSDT",
      rationale: "half the delta back, the rulebook asks for a hedge over the weekend",
      confidence: 0.5,
      horizonMinutes: 480,
    },
  ],
});

const OPTIONS = { runs: 2, shrink: 0.2, floorConfidence: 0.1, temperature: 0.7 };

function fakeClient(texts: string[]): LlmClient & { seen: LlmRequest[] } {
  let index = 0;
  return {
    model: "fake-qwen",
    seen: [] as LlmRequest[],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      (this as { seen: LlmRequest[] }).seen.push(req);
      const text = texts[Math.min(index, texts.length - 1)] ?? "";
      index += 1;
      return { text, promptTokens: 500, completionTokens: 40, latencyMs: 12, model: "fake-qwen" };
    },
  };
}

describe("QwenBrain", () => {
  it("is named qwen", () => {
    expect(new QwenBrain(fakeClient([REPLY]), OPTIONS).name).toBe("qwen");
  });

  it("produces a decision with a hedge and the counts behind it", async () => {
    const brain = new QwenBrain(fakeClient([REPLY]), OPTIONS);

    const decision = await brain.decide(WORLD, ACCOUNT, RULEBOOK);

    expect(decision.brain).toBe("qwen");
    expect(decision.modelCalls).toBe(2);
    expect(decision.targets.map((t) => t.symbol)).toEqual(["RTSLAUSDT", "TSLAUSDT"]);
    expect(decision.targets[1]).toMatchObject({
      targetNotionalUsdt: -500,
      hedgeFor: "RTSLAUSDT",
    });
    expect(brain.lastEnsemble?.invalidRuns).toBe(0);
  });

  it("decides exactly what the Claude brain decides on the same replies", async () => {
    const qwen = await new QwenBrain(fakeClient([REPLY]), OPTIONS).decide(
      WORLD,
      ACCOUNT,
      RULEBOOK,
    );
    const claude = await new ClaudeBrain(fakeClient([REPLY]), OPTIONS).decide(
      WORLD,
      ACCOUNT,
      RULEBOOK,
    );

    expect(qwen.targets).toEqual(claude.targets);
    expect(qwen.summary).toBe(claude.summary);
    expect(qwen.brain).not.toBe(claude.brain);
  });

  it("sees the same prompt the Claude brain sees", async () => {
    const qwenClient = fakeClient([REPLY]);
    const claudeClient = fakeClient([REPLY]);

    await new QwenBrain(qwenClient, OPTIONS).decide(WORLD, ACCOUNT, RULEBOOK);
    await new ClaudeBrain(claudeClient, OPTIONS).decide(WORLD, ACCOUNT, RULEBOOK);

    expect(qwenClient.seen[0]?.system).toBe(claudeClient.seen[0]?.system);
    expect(qwenClient.seen[0]?.user).toBe(claudeClient.seen[0]?.user);
  });
});
