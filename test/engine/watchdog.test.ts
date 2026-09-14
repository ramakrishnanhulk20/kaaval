// The tick watchdog: what happens when a tick never comes back. Does NOT cover pm2 doing
// the restart, the real process.exit (the exit function is injected here), whether the
// state written on the way out is complete, or the stuck promise itself, which stays stuck
// inside the process until it leaves.
import { describe, expect, it } from "vitest";
import { tickBudgetMs, watchTick, type Watchdog } from "../../scripts/run-engine.js";

function watchdog(over: Partial<Watchdog> = {}): { dog: Watchdog; lines: string[]; codes: number[]; saves: number } {
  const lines: string[] = [];
  const codes: number[] = [];
  const counters = { saves: 0 };
  const dog: Watchdog = {
    timeoutMs: 50,
    log: (line) => lines.push(line),
    onOverrun: () => {
      counters.saves += 1;
    },
    exit: (code) => codes.push(code),
    ...over,
  };
  return {
    dog,
    lines,
    codes,
    get saves() {
      return counters.saves;
    },
  };
}

describe("watchTick", () => {
  it("saves the state and exits with code 2 when a tick never comes back", async () => {
    const stuck = new Promise<never>(() => {});
    const w = watchdog();

    await expect(watchTick(stuck, w.dog)).rejects.toThrow(/overran its budget/);

    expect(w.lines).toContain("tick watchdog: 0 seconds, exiting for pm2 to restart");
    expect(w.saves).toBe(1);
    expect(w.codes).toEqual([2]);
  });

  it("still exits when saving the state throws on the way out", async () => {
    const stuck = new Promise<never>(() => {});
    const w = watchdog({
      onOverrun: () => {
        throw new Error("the disk is full");
      },
    });

    await expect(watchTick(stuck, w.dog)).rejects.toThrow(/overran its budget/);

    expect(w.lines.some((line) => line.includes("the disk is full"))).toBe(true);
    expect(w.codes).toEqual([2]);
  });

  it("returns the tick's own answer and exits nothing when the tick is in time", async () => {
    const w = watchdog({ timeoutMs: 2_000 });

    const result = await watchTick(Promise.resolve({ window: "normal", nextTickMs: 900_000 }), w.dog);

    expect(result).toEqual({ window: "normal", nextTickMs: 900_000 });
    expect(w.codes).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it("lets a tick that throws through as a throw, not as an overrun", async () => {
    const w = watchdog({ timeoutMs: 2_000 });

    await expect(watchTick(Promise.reject(new Error("bitget is down")), w.dog)).rejects.toThrow(
      "bitget is down",
    );
    expect(w.codes).toEqual([]);
  });
});

describe("tickBudgetMs", () => {
  it("gives a normal tick the full budget and a busy window four minutes", () => {
    expect(tickBudgetMs("normal", 600_000)).toBe(600_000);
    expect(tickBudgetMs("event", 600_000)).toBe(240_000);
    expect(tickBudgetMs("open", 600_000)).toBe(240_000);
  });

  it("never stretches a budget that was set shorter than four minutes", () => {
    expect(tickBudgetMs("open", 120_000)).toBe(120_000);
  });
});
