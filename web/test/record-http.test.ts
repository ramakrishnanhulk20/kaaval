import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The published record read over HTTP: the files the site asks for, and the instrument list
// it names symbols out of. It does not cover Next's own fetch cache, the disk reader beside
// it, or a real host: fetch is replaced here with a small map of paths to bodies, so what is
// proven is which paths are requested and what the reader does with what comes back.
//
// Worth knowing when reading the names below: every rToken Bitget lists today is RXUSDT for
// a coin called rX, so the name read out of the file and the name derived from the symbol
// agree. The file still has to be published, because Vidiyal's gate reads the same file for
// the whole instrument list and not just the names.

const BASE = "https://record.test";

const CONFIG = JSON.stringify({
  seq: 1,
  ts: 1789114889143,
  kind: "config",
  account: "kaaval",
  payload: { universe: ["RNVDAUSDT", "RVOOUSDT"], brains: ["claude"] },
});

// RVOOUSDT is left out on purpose: the engine rebuilds this file on its own clock, so a
// symbol the config still names can be one the newest file has dropped.
const UNIVERSE = JSON.stringify({
  entries: [{ rToken: { symbol: "RNVDAUSDT", baseCoin: "rNVDA" } }],
  hedges: [{ symbol: "SPYUSDT", category: "USDT-FUTURES" }],
  builtTs: 1789201035795,
});

function record(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "kaaval/manifest.json": JSON.stringify({ ledgerFiles: [{ name: "2026-09-11.jsonl" }] }),
    "kaaval/ledger/2026-09-11.jsonl": `${CONFIG}\n`,
    "kaaval/state/engine.json": JSON.stringify({ lastTickTs: 1789200034886 }),
    ...extra,
  };
}

/** Every path the reader asked for, in the order it asked, so a missing file is visible. */
let asked: string[] = [];

function serve(files: Record<string, string>): void {
  asked = [];
  vi.stubGlobal("fetch", (url: string) => {
    const path = String(url).slice(`${BASE}/`.length);
    asked.push(path);
    const body = files[path];
    return Promise.resolve(
      body === undefined
        ? { ok: false, status: 404, text: () => Promise.resolve("") }
        : { ok: true, status: 200, text: () => Promise.resolve(body) },
    );
  });
}

const { getUniverse } = await import("../lib/record-http");

beforeEach(() => {
  process.env["KAAVAL_RECORD_URL"] = BASE;
});

afterEach(() => {
  delete process.env["KAAVAL_RECORD_URL"];
  vi.unstubAllGlobals();
});

describe("the universe read from the published record", () => {
  it("asks for the published universe file and takes the exchange's own name from it", async () => {
    serve(record({ "kaaval/state/universe.json": UNIVERSE }));

    const universe = await getUniverse();

    expect(asked).toContain("kaaval/state/universe.json");
    expect(universe).toEqual([
      { symbol: "RNVDAUSDT", name: "rNVDA" },
      { symbol: "RVOOUSDT", name: "rVOO" },
    ]);
  });

  it("falls back to the name derived from the symbol when the record has no universe yet", async () => {
    serve(record());

    const universe = await getUniverse();

    expect(asked).toContain("kaaval/state/universe.json");
    expect(universe).toEqual([
      { symbol: "RNVDAUSDT", name: "rNVDA" },
      { symbol: "RVOOUSDT", name: "rVOO" },
    ]);
  });
});
