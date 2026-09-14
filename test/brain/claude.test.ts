// The Claude brain end to end with a fake client: prompt in, Decision out. Does NOT
// cover: the real Anthropic call (test/brain/llm.test.ts covers the request shape, and
// npm run proof:brains runs it live), or the aggregation rules, which ensemble.test.ts
// owns.
import { describe, expect, it } from "vitest";
import { ClaudeBrain } from "../../src/brain/claude.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../src/brain/llm.js";
import type { AccountView, WorldState } from "../../src/brain/types.js";

const RULEBOOK = "Per symbol: 10 percent of equity. Gross: 60 percent.";

const ACCOUNT: AccountView = {
  id: "kaaval-claude",
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
  ],
  news: [],
  calendar: [],
};

const REPLY = JSON.stringify({
  summary: "small long on the basis",
  targets: [
    {
      category: "SPOT",
      symbol: "RTSLAUSDT",
      targetNotionalUsdt: 800,
      hedgeFor: null,
      rationale: "1.2 percent above the anchor with nothing on the tape to justify it",
      confidence: 0.6,
      horizonMinutes: 240,
    },
  ],
});

function fakeClient(texts: string[]): LlmClient & { seen: LlmRequest[] } {
  let index = 0;
  return {
    model: "fake-claude",
    seen: [] as LlmRequest[],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      (this as { seen: LlmRequest[] }).seen.push(req);
      const text = texts[Math.min(index, texts.length - 1)] ?? "";
      index += 1;
      return { text, promptTokens: 500, completionTokens: 40, latencyMs: 12, model: "fake-claude" };
    },
  };
}

describe("ClaudeBrain", () => {
  it("is named claude", () => {
    expect(new ClaudeBrain(fakeClient([REPLY]), {
      runs: 1,
      shrink: 0.2,
      floorConfidence: 0.1,
      temperature: 0.7,
    }).name).toBe("claude");
  });

  it("turns a world state into a signed decision with the counts behind it", async () => {
    const client = fakeClient([REPLY]);
    const brain = new ClaudeBrain(client, {
      runs: 2,
      shrink: 0.2,
      floorConfidence: 0.1,
      temperature: 0.7,
    });

    const decision = await brain.decide(WORLD, ACCOUNT, RULEBOOK);

    expect(decision.brain).toBe("claude");
    expect(decision.modelCalls).toBe(2);
    expect(decision.promptTokens).toBe(1_000);
    expect(decision.completionTokens).toBe(80);
    expect(decision.latencyMs).toBe(24);
    expect(decision.summary).toBe("small long on the basis");
    expect(decision.targets[0]).toMatchObject({ symbol: "RTSLAUSDT", targetNotionalUsdt: 800 });
    expect(brain.lastEnsemble?.invalidRuns).toBe(0);
  });

  it("hands the client the rulebook and the world, not a summary of them", async () => {
    const client = fakeClient([REPLY]);
    const brain = new ClaudeBrain(client, {
      runs: 1,
      shrink: 0.2,
      floorConfidence: 0.1,
      temperature: 0.4,
    });

    await brain.decide(WORLD, ACCOUNT, RULEBOOK);

    expect(client.seen[0]?.system).toContain(RULEBOOK);
    expect(client.seen[0]?.user).toContain("RTSLAUSDT");
    expect(client.seen[0]?.temperature).toBe(0.4);
  });

  it("returns an empty decision, not a throw, when every run is unusable", async () => {
    const client = fakeClient(["sorry, no"]);
    const brain = new ClaudeBrain(client, {
      runs: 2,
      shrink: 0.2,
      floorConfidence: 0.1,
      temperature: 0.7,
    });

    const decision = await brain.decide(WORLD, ACCOUNT, RULEBOOK);

    expect(decision.targets).toEqual([]);
    expect(decision.summary).toContain("every model run came back invalid");
    expect(brain.lastEnsemble?.invalidRuns).toBe(2);
  });
});
