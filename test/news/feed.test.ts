// Merging the three sources into one feed, and the earnings calendar. The three adapters
// are replaced here so the merge can be tested without the network; each adapter has its
// own file for its own parsing. Does NOT cover: live calls (test/news/live.test.ts), the
// 80 item cap, the economic calendar's impact filter, or whether GDELT's own matching is
// any good for a batched query, which only the live test can show.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEdgar8k } from "../../src/news/edgar.js";
import { fetchFinnhub } from "../../src/news/finnhub.js";
import { gatherCalendar, gatherNews } from "../../src/news/feed.js";
import { fetchGdelt, type GdeltArticle } from "../../src/news/gdelt.js";

vi.mock("../../src/news/finnhub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/news/finnhub.js")>();
  return { ...actual, fetchFinnhub: vi.fn() };
});
vi.mock("../../src/news/edgar.js", () => ({ fetchEdgar8k: vi.fn() }));
vi.mock("../../src/news/gdelt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/news/gdelt.js")>();
  return { ...actual, fetchGdelt: vi.fn() };
});

const earningsFixture = JSON.parse(
  readFileSync(join(process.cwd(), "test", "fixtures", "news", "finnhub-earnings.json"), "utf8"),
) as { earningsCalendar: Array<Record<string, unknown>> };

const SYMBOLS = [
  { symbol: "RTSLAUSDT", underlying: "TSLA" },
  { symbol: "TSLAUSDT", underlying: "TSLA" },
  { symbol: "RNVDAUSDT", underlying: "NVDA" },
];

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const cacheDir = (): string => mkdtempSync(join(tmpdir(), "kaaval-feed-"));

beforeEach(() => {
  vi.mocked(fetchFinnhub).mockResolvedValue(null);
  vi.mocked(fetchEdgar8k).mockResolvedValue([]);
  vi.mocked(fetchGdelt).mockResolvedValue([]);
});

describe("gatherNews", () => {
  it("merges the sources, newest first, and tags every symbol a story touches", async () => {
    vi.mocked(fetchFinnhub).mockImplementation(async (_path, params) =>
      params["symbol"] === "TSLA"
        ? ([
            {
              datetime: (NOW - HOUR) / 1000,
              headline: "Tesla cuts prices in China",
              summary: "The move follows a slow August for NVDA suppliers.",
              url: "https://example.com/tsla-prices",
              source: "Reuters",
            },
          ] as never)
        : (null as never),
    );
    vi.mocked(fetchEdgar8k).mockImplementation(async (ticker) =>
      ticker === "NVDA"
        ? [
            {
              accession: "0001045810-26-000078",
              cik: "0001045810",
              company: "NVIDIA CORP",
              ticker: "NVDA",
              form: "8-K",
              items: ["2.02"],
              fileDate: "2026-09-03",
              ts: NOW - 2 * HOUR,
              headline: "NVIDIA CORP filed an 8-K with the SEC",
              description: null,
              url: "https://sec.gov/x",
            },
          ]
        : [],
    );
    vi.mocked(fetchGdelt).mockResolvedValue([
      {
        url: "https://example.com/gdelt",
        title: "Chip demand holds up into September",
        ts: NOW - 3 * HOUR,
        domain: "example.com",
        language: "English",
        sourceCountry: "United States",
      },
    ]);

    const news = await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(news.map((n) => n.headline)).toEqual([
      "Tesla cuts prices in China",
      "NVIDIA CORP filed an 8-K with the SEC",
      "Chip demand holds up into September",
    ]);
    expect(news[0]?.symbols).toEqual(["RTSLAUSDT", "TSLAUSDT", "RNVDAUSDT"]);
    expect(news[1]?.symbols).toEqual(["RNVDAUSDT"]);
    expect(news[0]?.source).toBe("finnhub/Reuters");
  });

  it("keeps one copy of a story that arrives from two sources", async () => {
    vi.mocked(fetchFinnhub).mockResolvedValue([
      {
        datetime: (NOW - HOUR) / 1000,
        headline: "Tesla cuts prices in China",
        summary: null,
        url: null,
        source: "Reuters",
      },
    ] as never);
    vi.mocked(fetchGdelt).mockImplementation(async (query) =>
      query.includes("TSLA")
        ? [
            {
              url: "https://example.com/same",
              title: "TESLA CUTS PRICES IN CHINA!",
              ts: NOW - 2 * HOUR,
              domain: "example.com",
              language: "English",
              sourceCountry: "United States",
            },
          ]
        : [],
    );

    const news = await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(news).toHaveLength(1);
    expect(news[0]?.headline).toBe("Tesla cuts prices in China");
    expect(news[0]?.url).toBe("https://example.com/same");
  });

  it("asks GDELT one batched question for every underlying, not one each", async () => {
    const queries: string[] = [];
    vi.mocked(fetchGdelt).mockImplementation(async (query) => {
      queries.push(query);
      return [];
    });

    await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(queries).toEqual(["(TSLA OR NVDA) (stock OR shares OR earnings) sourcelang:eng"]);
  });

  it("tags each batched article from its own title and drops the rest once three are tagged", async () => {
    const article = (title: string, hoursAgo: number): GdeltArticle => ({
      url: `https://example.com/${encodeURIComponent(title)}`,
      title,
      ts: NOW - hoursAgo * HOUR,
      domain: "example.com",
      language: "English",
      sourceCountry: "United States",
    });
    vi.mocked(fetchGdelt).mockResolvedValue([
      article("Tesla lifts guidance", 1),
      article("NVDA ships the next chip", 2),
      article("Tesla and Nvidia both rally", 3),
      article("Jobs report lands Friday", 4),
    ]);

    const news = await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(news.map((n) => n.headline)).toEqual([
      "Tesla lifts guidance",
      "NVDA ships the next chip",
      "Tesla and Nvidia both rally",
    ]);
    expect(news[0]?.symbols).toEqual(["RTSLAUSDT", "TSLAUSDT"]);
    expect(news[2]?.symbols).toEqual(["RTSLAUSDT", "TSLAUSDT", "RNVDAUSDT"]);
  });

  it("keeps the macro headlines with no symbol when almost nothing was tagged", async () => {
    vi.mocked(fetchGdelt).mockResolvedValue([
      {
        url: "https://example.com/tsla-guidance",
        title: "Tesla lifts guidance",
        ts: NOW - HOUR,
        domain: "example.com",
        language: "English",
        sourceCountry: "United States",
      },
      {
        url: "https://example.com/jobs",
        title: "Jobs report lands Friday",
        ts: NOW - 2 * HOUR,
        domain: "example.com",
        language: "English",
        sourceCountry: "United States",
      },
    ]);

    const news = await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(news).toHaveLength(2);
    expect(news[1]?.headline).toBe("Jobs report lands Friday");
    expect(news[1]?.symbols).toEqual([]);
  });

  it("leaves out anything older than the window asked for", async () => {
    vi.mocked(fetchGdelt).mockResolvedValue([
      {
        url: "https://example.com/old",
        title: "Last week's story",
        ts: NOW - 8 * 24 * HOUR,
        domain: "example.com",
        language: "English",
        sourceCountry: "United States",
      },
    ]);

    const news = await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(news).toEqual([]);
  });

  it("still returns the other sources when one has nothing to give", async () => {
    vi.mocked(fetchEdgar8k).mockResolvedValue([]);
    vi.mocked(fetchGdelt).mockResolvedValue([
      {
        url: "https://example.com/one",
        title: "The only story tonight",
        ts: NOW - HOUR,
        domain: "example.com",
        language: "English",
        sourceCountry: "United States",
      },
    ]);

    const news = await gatherNews({ symbols: SYMBOLS, sinceTs: NOW - 24 * HOUR, cacheDir: cacheDir() });

    expect(news).toHaveLength(1);
  });
});

describe("gatherCalendar", () => {
  it("turns the hour code into a timing and a New York instant", async () => {
    vi.mocked(fetchFinnhub).mockImplementation(async (path) =>
      path === "/calendar/earnings" ? (earningsFixture as never) : (null as never),
    );

    const events = await gatherCalendar({
      underlyings: ["AAPL"],
      fromTs: Date.parse("2026-09-08T00:00:00Z"),
      toTs: Date.parse("2026-09-12T00:00:00Z"),
      cacheDir: cacheDir(),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "earnings",
      symbol: "AAPL",
      timing: "after-close",
      ts: Date.parse("2026-09-09T20:05:00Z"),
    });
    expect(events[1]).toMatchObject({ symbol: "TSLA", timing: "before-open" });
  });

  it("returns nothing and writes a log line when there is no Finnhub key", async () => {
    const actual = await vi.importActual<typeof import("../../src/news/finnhub.js")>(
      "../../src/news/finnhub.js",
    );
    vi.mocked(fetchFinnhub).mockImplementation(actual.fetchFinnhub);
    vi.stubEnv("FINNHUB_API_KEY", "");
    const lines: string[] = [];

    const events = await gatherCalendar(
      {
        underlyings: ["AAPL"],
        fromTs: NOW,
        toTs: NOW + 7 * 24 * HOUR,
        cacheDir: cacheDir(),
      },
      (line) => lines.push(line),
    );

    expect(events).toEqual([]);
    expect(lines.join(" ")).toContain("FINNHUB_API_KEY is not set");
    vi.unstubAllEnvs();
  });
});
