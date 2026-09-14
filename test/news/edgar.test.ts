// The SEC EDGAR adapter, against responses recorded from the live endpoint on
// 2026-09-08 (see test/fixtures/news/SOURCES.md). Does NOT cover: the live endpoint
// (test/news/live.test.ts), forms other than 8-K, the submissions API, or what happens
// when SEC blocks a request for a missing User-Agent, which cannot be provoked offline.
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchEdgar8k } from "../../src/news/edgar.js";
import type { HttpResponse } from "../../src/news/http.js";
import { resetPacing } from "../../src/news/pace.js";

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "test", "fixtures", "news", name), "utf8");

const tickers = fixture("sec-company-tickers-subset.json");
const nvdaHits = fixture("edgar-8k-nvda.json");
const noHits = fixture("edgar-8k-empty.json");

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeGet(bodyFor: (url: string) => HttpResponse, calls: Call[] = []) {
  return async (url: string, headers: Record<string, string> = {}): Promise<HttpResponse> => {
    calls.push({ url, headers });
    return bodyFor(url);
  };
}

const route = (url: string): HttpResponse =>
  url.includes("company_tickers")
    ? { status: 200, body: tickers }
    : { status: 200, body: nvdaHits };

const options = (get: ReturnType<typeof fakeGet>, log?: (line: string) => void) => ({
  cacheDir: mkdtempSync(join(tmpdir(), "kaaval-edgar-")),
  fromDate: "2026-08-09",
  toDate: "2026-09-08",
  minSpacingMs: 0,
  userAgent: "Kaaval test contact@example.com",
  get,
  ...(log ? { log } : {}),
});

describe("fetchEdgar8k", () => {
  beforeEach(() => {
    resetPacing();
  });

  it("returns the filings for the company, newest first", async () => {
    const filings = await fetchEdgar8k("NVDA", options(fakeGet(route)));

    expect(filings).toHaveLength(3);
    expect(filings.map((f) => f.fileDate)).toEqual(["2026-09-03", "2026-08-26", "2026-08-17"]);
    expect(filings[0]?.company).toBe("NVIDIA CORP");
    expect(filings[0]?.ticker).toBe("NVDA");
    expect(filings[0]?.headline).toBe(
      "NVIDIA CORP filed an 8-K with the SEC covering item 8.01",
    );
    expect(filings[0]?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000078/nvda-20260902.htm",
    );
  });

  it("spells out the earnings item code so a brain can act on it", async () => {
    const earnings = JSON.parse(nvdaHits) as {
      hits: { hits: Array<{ _source: { items: string[] } }> };
    };
    const first = earnings.hits.hits[0];
    if (first) first._source.items = ["2.02", "9.01"];
    const filings = await fetchEdgar8k(
      "NVDA",
      options(
        fakeGet((url) =>
          url.includes("company_tickers")
            ? { status: 200, body: tickers }
            : { status: 200, body: JSON.stringify(earnings) },
        ),
      ),
    );

    expect(filings[0]?.headline).toContain("results of operations and financial condition");
  });

  it("collapses the exhibits of one submission into a single filing", async () => {
    const doubled = JSON.parse(nvdaHits) as {
      hits: { hits: Array<Record<string, unknown>> };
    };
    const first = doubled.hits.hits[0];
    if (first) {
      doubled.hits.hits.push({ ...first, _id: "0001045810-26-000078:ex991.htm" });
    }
    const filings = await fetchEdgar8k(
      "NVDA",
      options(
        fakeGet((url) =>
          url.includes("company_tickers")
            ? { status: 200, body: tickers }
            : { status: 200, body: JSON.stringify(doubled) },
        ),
      ),
    );

    expect(filings).toHaveLength(3);
    expect(new Set(filings.map((f) => f.accession)).size).toBe(3);
  });

  it("sends the User-Agent SEC demands on every call", async () => {
    const calls: Call[] = [];
    await fetchEdgar8k("NVDA", options(fakeGet(route, calls)));

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.headers["User-Agent"] === "Kaaval test contact@example.com")).toBe(
      true,
    );
    expect(calls[1]?.url).toContain("ciks=0001045810");
  });

  it("returns nothing and says so when SEC does not know the ticker", async () => {
    const lines: string[] = [];
    const filings = await fetchEdgar8k(
      "RTSLA",
      options(fakeGet(route), (line) => lines.push(line)),
    );

    expect(filings).toEqual([]);
    expect(lines.join(" ")).toContain("SEC lists no company for RTSLA");
  });

  it("returns nothing and says so when the search refuses", async () => {
    const lines: string[] = [];
    const filings = await fetchEdgar8k(
      "NVDA",
      options(
        fakeGet((url) =>
          url.includes("company_tickers")
            ? { status: 200, body: tickers }
            : { status: 403, body: "blocked" },
        ),
        (line) => lines.push(line),
      ),
    );

    expect(filings).toEqual([]);
    expect(lines.join(" ")).toContain("answered 403");
  });

  it("returns an empty list when the company filed nothing in the window", async () => {
    const filings = await fetchEdgar8k(
      "NVDA",
      options(
        fakeGet((url) =>
          url.includes("company_tickers")
            ? { status: 200, body: tickers }
            : { status: 200, body: noHits },
        ),
      ),
    );

    expect(filings).toEqual([]);
  });
});
