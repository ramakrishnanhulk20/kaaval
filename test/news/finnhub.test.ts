// The Finnhub adapter, against payloads built from the sample responses in Finnhub's own
// docs (reference/news/source-finnhub.md), because the endpoints need a key. Does NOT
// cover: the real endpoint (test/news/live.test.ts, which runs only with a key), the
// premium news-sentiment endpoint, or Finnhub's 429 behaviour under a real burst.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchFinnhub, type FinnhubNewsRow } from "../../src/news/finnhub.js";
import type { HttpResponse } from "../../src/news/http.js";
import { resetPacing } from "../../src/news/pace.js";

const news = readFileSync(
  join(process.cwd(), "test", "fixtures", "news", "finnhub-company-news.json"),
  "utf8",
);

const KEY = "test-key-not-a-real-token";

describe("fetchFinnhub", () => {
  beforeEach(() => {
    resetPacing();
  });

  it("returns null and says why when there is no key, without calling out", async () => {
    const lines: string[] = [];
    let calls = 0;
    const rows = await fetchFinnhub<FinnhubNewsRow[]>(
      "/company-news",
      { symbol: "NVDA" },
      {
        cacheDir: mkdtempSync(join(tmpdir(), "kaaval-finnhub-")),
        apiKey: "",
        log: (line) => lines.push(line),
        get: async () => {
          calls += 1;
          return { status: 200, body: news };
        },
      },
    );

    expect(rows).toBeNull();
    expect(calls).toBe(0);
    expect(lines.join(" ")).toContain("FINNHUB_API_KEY is not set");
  });

  it("parses the rows the feed reads", async () => {
    const rows = await fetchFinnhub<FinnhubNewsRow[]>(
      "/company-news",
      { symbol: "NVDA", from: "2025-09-01", to: "2025-09-08" },
      {
        cacheDir: mkdtempSync(join(tmpdir(), "kaaval-finnhub-")),
        apiKey: KEY,
        minSpacingMs: 0,
        get: async () => ({ status: 200, body: news }),
      },
    );

    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.headline).toBe("NVIDIA lifts data centre outlook after record quarter");
    expect(rows?.[0]?.source).toBe("Reuters");
  });

  it("keeps the key out of the cache file it writes", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "kaaval-finnhub-"));
    let calledUrl = "";
    await fetchFinnhub<FinnhubNewsRow[]>(
      "/company-news",
      { symbol: "NVDA" },
      {
        cacheDir,
        apiKey: KEY,
        minSpacingMs: 0,
        get: async (url) => {
          calledUrl = url;
          return { status: 200, body: news };
        },
      },
    );

    const file = readdirSync(cacheDir)[0] as string;
    expect(calledUrl).toContain(`token=${KEY}`);
    expect(readFileSync(join(cacheDir, file), "utf8")).not.toContain(KEY);
  });

  it("returns null and says why when Finnhub refuses", async () => {
    const lines: string[] = [];
    const rows = await fetchFinnhub<FinnhubNewsRow[]>(
      "/company-news",
      { symbol: "NVDA" },
      {
        cacheDir: mkdtempSync(join(tmpdir(), "kaaval-finnhub-")),
        apiKey: KEY,
        minSpacingMs: 0,
        log: (line) => lines.push(line),
        get: async () => ({ status: 429, body: "too many requests" }),
      },
    );

    expect(rows).toBeNull();
    expect(lines.join(" ")).toContain("answered 429");
  });

  it("serves a repeated request from the cache instead of spending a call", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "kaaval-finnhub-"));
    let calls = 0;
    const get = async (): Promise<HttpResponse> => {
      calls += 1;
      return { status: 200, body: news };
    };
    const opts = { cacheDir, apiKey: KEY, minSpacingMs: 0, get };

    await fetchFinnhub<FinnhubNewsRow[]>("/company-news", { symbol: "NVDA" }, opts);
    await fetchFinnhub<FinnhubNewsRow[]>("/company-news", { symbol: "NVDA" }, opts);

    expect(calls).toBe(1);
  });
});
