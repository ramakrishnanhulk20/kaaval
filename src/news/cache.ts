import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheOptions {
  dir: string;
  ttlMs: number;
}

interface CacheEntry<T> {
  request: unknown;
  fetchedAt: string;
  value: T;
}

/**
 * A stable fingerprint of a request. Object keys are sorted before hashing so two
 * calls that differ only in the order their parameters were built still share a file.
 * Never put a credential in the request object: this string ends up in a filename.
 */
export function requestHash(request: unknown): string {
  return createHash("sha1").update(stable(request)).digest("hex").slice(0, 20);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

export function readCache<T>(
  opts: CacheOptions,
  hash: string,
  now: number = Date.now(),
): T | null {
  const path = join(opts.dir, `${hash}.json`);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<T>;
    const age = now - Date.parse(entry.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > opts.ttlMs) return null;
    return entry.value;
  } catch {
    return null;
  }
}

export function writeCache<T>(opts: CacheOptions, hash: string, request: unknown, value: T): void {
  mkdirSync(opts.dir, { recursive: true });
  const entry: CacheEntry<T> = { request, fetchedAt: new Date().toISOString(), value };
  writeFileSync(join(opts.dir, `${hash}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

/**
 * Serve a request from disk when a fresh copy is there, otherwise run it and store the
 * answer. A source that is rate limited or paid is called once per TTL, no matter how
 * many ticks ask for it, and a tick that repeats after a crash costs nothing.
 */
export async function withCache<T>(
  opts: CacheOptions,
  request: unknown,
  run: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const hash = requestHash(request);
  const hit = readCache<T>(opts, hash);
  if (hit !== null) return { value: hit, cached: true };
  const value = await run();
  writeCache(opts, hash, request, value);
  return { value, cached: false };
}
