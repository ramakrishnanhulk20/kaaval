// Hits the real news sources, so it runs only with LIVE=1 in the environment. It checks
// shapes and freshness, never contents: the news changes every hour and a test that
// asserts a headline is a test that fails tomorrow. Does NOT cover: Finnhub without a
// key (that block is skipped), rate limit behaviour under load, or how complete any
// source is, which no test can prove. The batched GDELT check accepts a refusal: GDELT
// is free and may answer 429 twice, and the point of that branch is that the backoff was
// honoured and the tick survived, not that news exists at this minute. There is one GDELT
// test and it makes one request, because a second request in the same run is the thing
// that gets this machine refused.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchEdgar8k } from "../../src/news/edgar.js";
import { fetchFinnhub, type FinnhubNewsRow } from "../../src/news/finnhub.js";
import { fetchGdelt, gdeltBatchQuery, tagSymbols } from "../../src/news/gdelt.js";

const live = process.env["LIVE"] === "1";
const hasFinnhubKey = Boolean(process.env["FINNHUB_API_KEY"]);
const TIMEOUT_MS = 120_000;

const cacheDir = (): string => mkdtempSync(join(tmpdir(), "kaaval-live-news-"));

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe.runIf(live)("live news sources", () => {
  it(
    "reads NVIDIA's recent 8-K filings from SEC EDGAR with no key",
    async () => {
      const filings = await fetchEdgar8k("NVDA", {
        cacheDir: cacheDir(),
        fromDate: isoDaysAgo(120),
        toDate: isoDaysAgo(0),
      });

      expect(filings.length).toBeGreaterThan(0);
      expect(filings[0]?.ticker).toBe("NVDA");
      expect(filings[0]?.form).toBe("8-K");
      expect(filings[0]?.url).toContain("sec.gov/Archives");
      expect(filings.map((f) => f.ts)).toEqual([...filings.map((f) => f.ts)].sort((a, b) => b - a));
    },
    TIMEOUT_MS,
  );

  it(
    "covers five underlyings in one batched GDELT call and tags what comes back",
    async () => {
      const underlyings = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"];
      const symbols = underlyings.map((u) => ({ symbol: `R${u}USDT`, underlying: u }));
      const lines: string[] = [];
      const startedAt = Date.now();

      const articles = await fetchGdelt(gdeltBatchQuery(underlyings), {
        cacheDir: cacheDir(),
        timespanHours: 24,
        maxRecords: 75,
        log: (line) => lines.push(line),
      });

      const requests = lines.filter((line) => line.includes("requesting"));
      expect(requests).toHaveLength(1);

      if (articles.length === 0) {
        console.log(`GDELT refused the batch: ${lines.join(" | ")}`);
        expect(lines.join(" ")).toMatch(/429|failed/);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20_000);
        return;
      }

      const tagged = articles.filter((a) => tagSymbols(a, symbols).length > 0);
      console.log(`GDELT answered ${articles.length} articles, ${tagged.length} tagged`);
      expect(tagged.length).toBeGreaterThan(0);
      expect(articles[0]?.url).toMatch(/^https?:\/\//);
      expect(articles[0]?.ts).toBeGreaterThan(Date.now() - 7 * 24 * 60 * 60 * 1000);
      expect(articles[0]?.ts).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    },
    TIMEOUT_MS,
  );

  it.runIf(hasFinnhubKey)(
    "reads company news from Finnhub when a key is set",
    async () => {
      const rows = await fetchFinnhub<FinnhubNewsRow[]>(
        "/company-news",
        { symbol: "NVDA", from: isoDaysAgo(7), to: isoDaysAgo(0) },
        { cacheDir: cacheDir() },
      );

      expect(Array.isArray(rows)).toBe(true);
      for (const row of rows ?? []) {
        expect(typeof row.headline).toBe("string");
        expect(typeof row.datetime).toBe("number");
      }
    },
    TIMEOUT_MS,
  );
});
