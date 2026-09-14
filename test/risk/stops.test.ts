import { describe, expect, it } from "vitest";
import { formatAmount, stopDryRunRequest, stopFor, triggeredStops } from "../../src/risk/stops.js";
import { DEFAULT_RULEBOOK } from "../../src/risk/rulebook.js";
import { position } from "./world.js";

// Covers where a stop sits, when the recorded book has passed it, and the shape of the
// Agent Hub request that would place it. It does not cover what the stop fills at once
// it triggers, which is the fill model's job, and it does not place anything on Bitget.

const TS = 1_789_099_200_000;

describe("stopFor", () => {
  it("puts an rToken long three percent under its entry", () => {
    const stop = stopFor(position({ avgEntry: 400, qty: 2 }), DEFAULT_RULEBOOK, TS);
    expect(stop).toEqual({
      category: "SPOT",
      symbol: "RTSLAUSDT",
      side: "sell",
      triggerPrice: 388,
      qty: 2,
      positionSide: "long",
      createdTs: TS,
    });
  });

  it("puts a perpetual short two percent over its entry", () => {
    const stop = stopFor(
      position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "short", avgEntry: 100, qty: 5 }),
      DEFAULT_RULEBOOK,
      TS,
    );
    expect(stop).toMatchObject({ side: "buy", triggerPrice: 102, positionSide: "short" });
  });
});

describe("triggeredStops", () => {
  const long = stopFor(position({ avgEntry: 400 }), DEFAULT_RULEBOOK, TS);
  const short = stopFor(
    position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "short", avgEntry: 100 }),
    DEFAULT_RULEBOOK,
    TS,
  );

  it("measures a long against the bid and a short against the ask", () => {
    const quotes = new Map([
      ["SPOT:RTSLAUSDT", { bid: 388, ask: 388.4 }],
      ["USDT-FUTURES:TSLAUSDT", { bid: 101.9, ask: 102 }],
    ]);
    expect(triggeredStops([long, short], quotes)).toEqual([long, short]);
  });

  it("leaves a stop alone while the price is still on the right side of it", () => {
    const quotes = new Map([
      ["SPOT:RTSLAUSDT", { bid: 388.01, ask: 388.4 }],
      ["USDT-FUTURES:TSLAUSDT", { bid: 101.8, ask: 101.99 }],
    ]);
    expect(triggeredStops([long, short], quotes)).toEqual([]);
  });

  it("treats a missing quote as no news, not as a trigger", () => {
    expect(triggeredStops([long, short], new Map())).toEqual([]);
  });
});

describe("stopDryRunRequest", () => {
  it("builds the placeStrategyOrder arguments with every value as a string", () => {
    const stop = stopFor(
      position({ category: "USDT-FUTURES", symbol: "TSLAUSDT", side: "long", avgEntry: 400, qty: 1.25 }),
      DEFAULT_RULEBOOK,
      TS,
    );
    expect(stopDryRunRequest(stop)).toEqual({
      category: "USDT-FUTURES",
      symbol: "TSLAUSDT",
      type: "tpsl",
      tpslMode: "partial",
      qty: "1.25",
      posSide: "long",
      slTriggerBy: "market",
      stopLoss: "392",
      slOrderType: "market",
      clientOid: `kaaval-stop-tslausdt-${TS}`,
    });
  });
});

describe("formatAmount", () => {
  it("writes a plain decimal with no exponent and no trailing zeros", () => {
    expect(formatAmount(1.25)).toBe("1.25");
    expect(formatAmount(0.00000001)).toBe("0.00000001");
    expect(formatAmount(1_000)).toBe("1000");
  });

  it("turns a size that is not a number into zero, which Bitget refuses", () => {
    expect(formatAmount(Number.NaN)).toBe("0");
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatAmount(Number.NEGATIVE_INFINITY)).toBe("0");
  });

  it("never writes a negative zero", () => {
    expect(formatAmount(-0)).toBe("0");
    expect(formatAmount(-0.000000001)).toBe("0");
  });
});
