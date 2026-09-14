// The GDELT adapter, against a response recorded from the live endpoint on 2026-09-08
// (see test/fixtures/news/SOURCES.md). Does NOT cover: the live endpoint
// (test/news/live.test.ts), how relevant GDELT's matching is for a given query, whether
// GDELT itself accepts a twenty five term OR block, the non-English feed, or the real
// eight second gap, which is set to zero here so the suite does not sit still.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fetchGdelt,
  gdeltBatchQueries,
  gdeltBatchQuery,
  tagSymbols,
} from "../../src/news/gdelt.js";
import type { HttpResponse } from "../../src/news/http.js";
import { resetPacing } from "../../src/news/pace.js";

const body = readFileSync(join(process.cwd(), "test", "fixtures", "news", "gdelt-tesla.json"), "utf8");

const options = (
  get: (url: string) => Promise<HttpResponse>,
  log?: (line: string) => void,
): Parameters<typeof fetchGdelt>[1] => ({
  cacheDir: mkdtempSync(join(tmpdir(), "kaaval-gdelt-")),
  timespanHours: 24,
  minSpacingMs: 0,
  retryDelayMs: 0,
  get,
  ...(log ? { log } : {}),
});

describe("fetchGdelt", () => {
  beforeEach(() => {
    resetPacing();
  });

  it("reads GDELT's own date format and returns the newest article first", async () => {
    const articles = await fetchGdelt("TSLA", options(async () => ({ status: 200, body })));

    expect(articles).toHaveLength(20);
    expect(articles[0]?.ts).toBe(Date.parse("2026-09-08T14:30:00Z"));
    expect(articles[0]?.title).toBe("Tesla Sales Crippled In World Biggest EV Country");
    expect(articles[0]?.domain).toBe("aol.com");
    for (let i = 1; i < articles.length; i += 1) {
      expect(articles[i - 1]?.ts).toBeGreaterThanOrEqual(articles[i]?.ts ?? 0);
    }
  });

  it("asks for the window and the sort order it needs", async () => {
    let seen = "";
    await fetchGdelt(
      "TSLA stock",
      options(async (url) => {
        seen = url;
        return { status: 200, body };
      }),
    );

    expect(seen).toContain("timespan=24h");
    expect(seen).toContain("sort=datedesc");
    expect(seen).toContain("query=TSLA+stock");
  });

  it("waits and retries once when GDELT rate limits the call", async () => {
    const lines: string[] = [];
    let calls = 0;
    const articles = await fetchGdelt(
      "TSLA",
      options(async () => {
        calls += 1;
        return calls === 1 ? { status: 429, body: "please limit requests" } : { status: 200, body };
      }, (line) => lines.push(line)),
    );

    expect(calls).toBe(2);
    expect(articles).toHaveLength(20);
    expect(lines.join(" ")).toContain("rate limited");
  });

  it("gives up quietly when the retry is refused too", async () => {
    const lines: string[] = [];
    const articles = await fetchGdelt(
      "TSLA",
      options(async () => ({ status: 429, body: "please limit requests" }), (line) =>
        lines.push(line),
      ),
    );

    expect(articles).toEqual([]);
    expect(lines.join(" ")).toContain("answered 429");
  });

  it("asks for an explicit window when the caller gives a date range", async () => {
    let seen = "";
    await fetchGdelt("TSLA", {
      ...options(async (url) => {
        seen = url;
        return { status: 200, body };
      }),
      range: {
        fromTs: Date.parse("2026-08-01T09:30:00Z"),
        toTs: Date.parse("2026-08-02T16:00:00Z"),
      },
    });

    expect(seen).toContain("startdatetime=20260801093000");
    expect(seen).toContain("enddatetime=20260802160000");
    expect(seen).not.toContain("timespan=");
  });

  it("keeps the range answer in its own cache entry, not the timespan one", async () => {
    const shared = options(async () => ({ status: 200, body }));
    let calls = 0;
    const counting = { ...shared, get: async () => {
      calls += 1;
      return { status: 200, body };
    } };

    await fetchGdelt("TSLA", counting);
    await fetchGdelt("TSLA", counting);
    await fetchGdelt("TSLA", {
      ...counting,
      range: { fromTs: Date.parse("2026-08-01T00:00:00Z"), toTs: Date.parse("2026-08-02T00:00:00Z") },
    });

    expect(calls).toBe(2);
  });

  it("drops an article with no usable timestamp rather than guessing one", async () => {
    const broken = JSON.stringify({
      articles: [
        { url: "https://example.com/a", title: "No date here", seendate: "yesterday" },
        { url: "https://example.com/b", title: "Dated", seendate: "20260908T120000Z" },
      ],
    });
    const articles = await fetchGdelt("TSLA", options(async () => ({ status: 200, body: broken })));

    expect(articles).toHaveLength(1);
    expect(articles[0]?.title).toBe("Dated");
  });
});

describe("gdeltBatchQuery", () => {
  it("asks about every underlying in one question", () => {
    expect(gdeltBatchQuery(["TSLA", "NVDA", "AAPL"])).toBe(
      "(TSLA OR NVDA OR AAPL) (stock OR shares OR earnings) sourcelang:eng",
    );
  });

  it("upper cases, trims and drops repeats so one ticker is asked about once", () => {
    expect(gdeltBatchQuery([" tsla ", "TSLA", "nvda", ""])).toBe(
      "(TSLA OR NVDA) (stock OR shares OR earnings) sourcelang:eng",
    );
  });

  it("returns nothing to ask when the list is empty", () => {
    expect(gdeltBatchQuery([])).toBe("");
    expect(gdeltBatchQueries([])).toEqual([]);
  });

  it("asks about a single ticker without parentheses, which GDELT refuses around one term", () => {
    expect(gdeltBatchQuery(["TSLA"])).toBe("TSLA (stock OR shares OR earnings) sourcelang:eng");
  });

  it("splits a list longer than twenty five into several questions", () => {
    const many = Array.from({ length: 60 }, (_, i) => `T${i}`);
    const queries = gdeltBatchQueries(many);

    const tickers = (query: string): string[] =>
      (/^\(([^)]+)\)/.exec(query)?.[1] ?? "").split(" OR ");

    expect(queries).toHaveLength(3);
    expect(tickers(queries[0] ?? "")).toHaveLength(25);
    expect(tickers(queries[2] ?? "")).toHaveLength(10);
    expect(tickers(queries[0] ?? "")[0]).toBe("T0");
    expect(tickers(queries[1] ?? "")[0]).toBe("T25");
  });
});

describe("tagSymbols", () => {
  const SYMBOLS = [
    { symbol: "RTSLAUSDT", underlying: "TSLA" },
    { symbol: "TSLAUSDT", underlying: "TSLA" },
    { symbol: "RNVDAUSDT", underlying: "NVDA" },
    { symbol: "RMUUSDT", underlying: "MU" },
  ];

  it("tags every symbol whose ticker is a word in the title", () => {
    const tags = tagSymbols(
      { title: "TSLA slips as NVDA climbs", url: "https://example.com/markets" },
      SYMBOLS,
    );

    expect(tags).toEqual(["RTSLAUSDT", "TSLAUSDT", "RNVDAUSDT"]);
  });

  it("reads the url path and ignores the domain", () => {
    const tags = tagSymbols(
      { title: "Chip demand holds up", url: "https://nvda-times.com/2026/09/mu-memory-prices" },
      SYMBOLS,
    );

    expect(tags).toEqual(["RMUUSDT"]);
  });

  it("matches a ticker written in lower case but never inside a longer word", () => {
    expect(tagSymbols({ title: "tsla delivery numbers", url: "https://e.com/a" }, SYMBOLS)).toEqual([
      "RTSLAUSDT",
      "TSLAUSDT",
    ]);
    expect(tagSymbols({ title: "Museum reopens in Munich", url: "https://e.com/a" }, SYMBOLS)).toEqual(
      [],
    );
  });

  it("knows the company name for the big tickers", () => {
    const tags = tagSymbols(
      { title: "Nvidia beats again as Micron guides higher", url: "https://e.com/a" },
      SYMBOLS,
    );

    expect(tags).toEqual(["RNVDAUSDT", "RMUUSDT"]);
  });

  it("returns an empty list for a story that names nothing we hold", () => {
    expect(
      tagSymbols({ title: "Jobs report lands Friday", url: "https://e.com/jobs" }, SYMBOLS),
    ).toEqual([]);
  });
});
