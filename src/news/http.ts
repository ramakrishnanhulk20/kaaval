import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpGet = (
  url: string,
  headers?: Record<string, string>,
  timeoutMs?: number,
) => Promise<HttpResponse>;

const FALLBACK_TIMEOUT_MS = 20_000;

/**
 * A request that ran past its budget, thrown so the adapters treat it as the soft
 * failure they already handle: the source is logged as skipped and the tick goes on.
 */
export class HttpTimeout extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`GET ${hostOf(url)} timed out after ${seconds(timeoutMs)} seconds`);
    this.name = "HttpTimeout";
  }
}

/**
 * How long one request may take, headers and body together, from KAAVAL_HTTP_TIMEOUT_MS.
 * Read on every call rather than once at import, so a test can set its own budget and a
 * restart is enough to change the engine's.
 */
export function httpTimeoutMs(): number {
  const raw = process.env["KAAVAL_HTTP_TIMEOUT_MS"];
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return FALLBACK_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * One GET, over Node's fetch, with node:http as the fallback.
 *
 * GDELT's api host resolves to a single IPv4 address whose TCP handshake took 11 to 15
 * seconds from this machine when measured on 2026-09-08. Node's fetch abandons a connect
 * after 10 seconds and that limit cannot be raised without pulling in undici, so roughly
 * three calls in four failed with UND_ERR_CONNECT_TIMEOUT while curl and node:https both
 * succeeded. The fallback takes our own timeout, so the slow handshake completes. A real
 * HTTP answer, including a 404 or a 429, comes straight back from fetch and never
 * reaches the fallback.
 *
 * Both legs are bounded by timeoutMs, covering the headers and the body read, so the
 * longest a dead host can hold a tick is two budgets: one for fetch failing to connect
 * and one for the fallback. Our own timeout skips the fallback, because a host that has
 * already used the whole budget has answered the question.
 */
export const httpGet: HttpGet = async (url, headers = {}, timeoutMs = httpTimeoutMs()) => {
  try {
    return await getOverFetch(url, headers, timeoutMs);
  } catch (err) {
    if (err instanceof HttpTimeout) throw err;
    return await getOverNodeHttp(url, headers, timeoutMs);
  }
};

async function getOverFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { headers, signal });
    // fetch resolves as soon as the headers land, so a server that sends a status line
    // and then stops would leave the body read waiting with nothing to time it out. The
    // signal aborts the socket underneath; the race is what turns that into an error
    // here even if the stream is mid-read and never sees the abort itself.
    const watch = rejectOnAbort(signal, url, timeoutMs);
    try {
      const body = await Promise.race([res.text(), watch.promise]);
      return { status: res.status, body };
    } finally {
      watch.done();
    }
  } catch (err) {
    if (err instanceof HttpTimeout) throw err;
    if (signal.aborted) throw new HttpTimeout(url, timeoutMs);
    throw err;
  }
}

/**
 * The same GET through node:http or node:https, which connect on our timeout rather
 * than on fetch's fixed ten seconds. Exported so the timeout can be tested directly
 * against a local server; the adapters all go through httpGet.
 */
export function getOverNodeHttp(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponse> {
  const target = new URL(url);
  const send = target.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      act();
    };

    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port ? { port: target.port } : {}),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, body })));
        res.on("error", (err: Error) => finish(() => reject(err)));
      },
    );

    // The socket timeout above only measures silence, so a server that dribbles one byte
    // every few seconds resets it forever. This deadline covers the whole call instead.
    deadline = setTimeout(() => req.destroy(new HttpTimeout(url, timeoutMs)), timeoutMs);
    req.on("timeout", () => req.destroy(new HttpTimeout(url, timeoutMs)));
    req.on("error", (err) => finish(() => reject(err)));
    req.end();
  });
}

function rejectOnAbort(
  signal: AbortSignal,
  url: string,
  timeoutMs: number,
): { promise: Promise<never>; done: () => void } {
  let onAbort = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new HttpTimeout(url, timeoutMs));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, done: () => signal.removeEventListener("abort", onAbort) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 20000 reads as "20", 300 as "0.3", so a short test budget still says something true. */
function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}
