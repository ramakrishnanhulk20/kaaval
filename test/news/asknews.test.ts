// The AskNews adapter, against payloads shaped like the search endpoint's as_dicts rows
// (reference/news/source-asknews.md). The endpoint needs a key, so nothing here touches
// the network. Does NOT cover: the real endpoint, how good AskNews' own matching is, what
// an archive search actually costs in credits, or the two second pacing under a burst.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { askNewsQuestion, fetchAskNews } from "../../src/news/asknews.js";
import type { HttpResponse } from "../../src/news/http.js";
import { resetPacing } from "../../src/news/pace.js";

const KEY = "test-key";
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const cacheDir = (): string => mkdtempSync(join(tmpdir(), "kaaval-asknews-"));

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  article_id: "a1",
  article_url: "https://example.com/a1",
  eng_title: "Tesla lifts guidance",
  title: "Tesla hebt seine Prognose an",
  summary: "The carmaker raised its delivery outlook for the quarter.",
  pub_date: "2026-09-19T10:00:00Z",
  domain_url: "https://www.reuters.com/markets/tesla",
  source_id: "reuters",
  language: "de",
  ...over,
});

const payload = (rows: Array<Record<string, unknown>>): string => JSON.stringify({ as_dicts: rows });

describe("askNewsQuestion", () => {
  it("names each company once with its ticker, and a ticker alone when we know no name", () => {
    expect(askNewsQuestion(["nvda", "NVDA", "spy", " ", "ZZZZ"])).toBe(
      "News moving the shares of Nvidia (NVDA), S&P 500 (SPY), ZZZZ",
    );
  });

  it("asks nothing when there is no ticker", () => {
    expect(askNewsQuestion([" "])).toBe("");
  });
});

describe("fetchAskNews", () => {
  beforeEach(() => {
    resetPacing();
  });

  it("returns nothing and says why when there is no key, without calling out", async () => {
    const lines: string[] = [];
    let calls = 0;

    const articles = await fetchAskNews(["TSLA"], { fromTs: NOW - 6 * HOUR }, {
      cacheDir: cacheDir(),
      apiKey: "",
      log: (line) => lines.push(line),
      get: async () => {
        calls += 1;
        return { status: 200, body: payload([row()]) };
      },
    });

    expect(articles).toEqual([]);
    expect(calls).toBe(0);
    expect(lines).toEqual(["asknews: ASKNEWS_API_KEY is not set, skipping news search"]);
  });

  it("sends the key in the header and leaves it out of the url and the cache file", async () => {
    const dir = cacheDir();
    let calledUrl = "";
    let calledHeaders: Record<string, string> = {};

    // Half past the hour, so the round up to whole hours cannot land on either side of
    // six while the test runs.
    await fetchAskNews(["TSLA", "NVDA"], { fromTs: Date.now() - 5.5 * HOUR }, {
      cacheDir: dir,
      apiKey: KEY,
      minSpacingMs: 0,
      get: async (url, headers) => {
        calledUrl = url;
        calledHeaders = headers ?? {};
        return { status: 200, body: payload([row()]) };
      },
    });

    expect(calledHeaders["Authorization"]).toBe(`Bearer ${KEY}`);
    expect(calledUrl).not.toContain(KEY);
    expect(new URL(calledUrl).searchParams.get("method")).toBe("nl");
    expect(new URL(calledUrl).searchParams.get("n_articles")).toBe("10");
    expect(new URL(calledUrl).searchParams.get("query")).toContain("Tesla (TSLA)");
    expect(new URL(calledUrl).searchParams.get("hours_back")).toBe("6");
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), "utf8")).not.toContain(KEY);
    }
  });

  it("spends one request for two ticks inside the same hour", async () => {
    const dir = cacheDir();
    let calls = 0;
    const get = async (): Promise<HttpResponse> => {
      calls += 1;
      return { status: 200, body: payload([row()]) };
    };
    const opts = { cacheDir: dir, apiKey: KEY, minSpacingMs: 0, get };

    await fetchAskNews(["TSLA"], { fromTs: NOW - 6 * HOUR }, opts);
    const second = await fetchAskNews(["TSLA"], { fromTs: NOW - 6 * HOUR }, opts);

    expect(calls).toBe(1);
    expect(second).toHaveLength(1);
  });

  it("returns nothing and logs a skipped source when AskNews refuses", async () => {
    const lines: string[] = [];

    const articles = await fetchAskNews(["TSLA"], { fromTs: NOW - 6 * HOUR }, {
      cacheDir: cacheDir(),
      apiKey: KEY,
      minSpacingMs: 0,
      log: (line) => lines.push(line),
      get: async () => ({ status: 429, body: "too many requests" }),
    });

    expect(articles).toEqual([]);
    expect(lines.join(" ")).toContain(" failed, skipping");
    expect(lines.join(" ")).toContain("answered 429");
    expect(lines.join(" ")).not.toContain(KEY);
  });

  it("drops rows with no date and no title, and cuts a long summary", async () => {
    const articles = await fetchAskNews(["TSLA"], { fromTs: NOW - 6 * HOUR }, {
      cacheDir: cacheDir(),
      apiKey: KEY,
      minSpacingMs: 0,
      get: async () => ({
        status: 200,
        body: payload([
          row({ article_id: "bad-date", pub_date: "sometime last week" }),
          row({ article_id: "no-title", eng_title: undefined, title: "  " }),
          row({ article_id: "good", summary: "x".repeat(400) }),
        ]),
      }),
    });

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      id: "good",
      title: "Tesla lifts guidance",
      url: "https://example.com/a1",
      domain: "www.reuters.com",
      ts: Date.parse("2026-09-19T10:00:00Z"),
    });
    expect(articles[0]?.summary).toHaveLength(280);
  });

  it("does not touch an archive window unless ASKNEWS_HISTORICAL is 1", async () => {
    const before = process.env["ASKNEWS_HISTORICAL"];
    const lines: string[] = [];
    let calls = 0;
    const opts = {
      cacheDir: cacheDir(),
      apiKey: KEY,
      minSpacingMs: 0,
      log: (line: string) => lines.push(line),
      get: async (): Promise<HttpResponse> => {
        calls += 1;
        return { status: 200, body: payload([row()]) };
      },
    };
    const window = { fromTs: NOW - 5 * 24 * HOUR, toTs: NOW - 4 * 24 * HOUR };

    try {
      delete process.env["ASKNEWS_HISTORICAL"];
      expect(await fetchAskNews(["TSLA"], window, opts)).toEqual([]);
      expect(calls).toBe(0);
      expect(lines).toEqual([
        "asknews: historical search is off (ASKNEWS_HISTORICAL is not 1), skipping news search",
      ]);

      process.env["ASKNEWS_HISTORICAL"] = "1";
      expect(await fetchAskNews(["TSLA"], window, opts)).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      if (before === undefined) delete process.env["ASKNEWS_HISTORICAL"];
      else process.env["ASKNEWS_HISTORICAL"] = before;
    }
  });

  it("asks a recent closed window by unix seconds, not milliseconds", async () => {
    let calledUrl = "";
    const window = { fromTs: NOW - 3 * HOUR, toTs: NOW - HOUR };

    await fetchAskNews(["TSLA"], window, {
      cacheDir: cacheDir(),
      apiKey: KEY,
      minSpacingMs: 0,
      get: async (url) => {
        calledUrl = url;
        return { status: 200, body: payload([row()]) };
      },
    });

    const params = new URL(calledUrl).searchParams;
    expect(params.get("start_timestamp")).toBe(String(Math.floor(window.fromTs / 1000)));
    expect(params.get("end_timestamp")).toBe(String(Math.floor(window.toTs / 1000)));
    expect(params.get("historical")).toBeNull();
    expect(params.get("hours_back")).toBeNull();
  });
});
