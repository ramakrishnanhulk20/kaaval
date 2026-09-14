// The disk cache and the per-source pacing that keep the free news feeds inside their
// limits. Does NOT cover: two processes writing the same key at once, a full disk, cache
// eviction (nothing prunes old files yet), or the adapters that use this, which have
// their own files.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readCache, requestHash, withCache, writeCache } from "../../src/news/cache.js";
import { pace, resetPacing } from "../../src/news/pace.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "kaaval-cache-"));

describe("requestHash", () => {
  it("ignores the order the request was built in", () => {
    expect(requestHash({ a: 1, b: [2, 3] })).toBe(requestHash({ b: [2, 3], a: 1 }));
  });

  it("separates requests that differ anywhere", () => {
    expect(requestHash({ symbol: "TSLA" })).not.toBe(requestHash({ symbol: "NVDA" }));
  });
});

describe("withCache", () => {
  it("runs once and serves the second call from disk", async () => {
    const opts = { dir: dir(), ttlMs: 60_000 };
    let calls = 0;
    const run = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    const first = await withCache(opts, { q: "one" }, run);
    const second = await withCache(opts, { q: "one" }, run);

    expect(first).toEqual({ value: 1, cached: false });
    expect(second).toEqual({ value: 1, cached: true });
    expect(calls).toBe(1);
    expect(readdirSync(opts.dir)).toHaveLength(1);
  });

  it("runs again once the entry is older than the TTL", async () => {
    const opts = { dir: dir(), ttlMs: 1 };
    await withCache(opts, { q: "two" }, async () => "first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await withCache(opts, { q: "two" }, async () => "second");

    expect(again).toEqual({ value: "second", cached: false });
  });

  it("treats an unreadable entry as a miss instead of throwing", () => {
    const opts = { dir: dir(), ttlMs: 60_000 };
    const hash = requestHash({ q: "three" });
    writeCache(opts, hash, { q: "three" }, "good");
    writeFileSync(join(opts.dir, `${hash}.json`), "{ this is not json", "utf8");

    expect(readCache(opts, hash)).toBeNull();
  });

  it("stores the request next to the answer so a cache file can be audited", async () => {
    const opts = { dir: dir(), ttlMs: 60_000 };
    await withCache(opts, { source: "gdelt", query: "TSLA" }, async () => [1, 2]);
    const file = readdirSync(opts.dir)[0] as string;
    const entry = JSON.parse(readFileSync(join(opts.dir, file), "utf8")) as {
      request: unknown;
      value: unknown;
    };

    expect(entry.request).toEqual({ source: "gdelt", query: "TSLA" });
    expect(entry.value).toEqual([1, 2]);
  });
});

describe("pace", () => {
  beforeEach(() => {
    resetPacing();
  });

  it("holds the second call to one source for the full gap", async () => {
    const startedAt = Date.now();
    await pace("gdelt", 40);
    await pace("gdelt", 40);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it("does not make one source wait for another", async () => {
    await pace("gdelt", 200);
    const startedAt = Date.now();
    await pace("edgar", 200);

    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
