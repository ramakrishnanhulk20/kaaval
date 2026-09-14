// The request timeout: a host that never answers, and a host that sends headers and then
// stops. Does NOT cover TLS, DNS failures, the fallback from fetch to node:http on a real
// slow handshake (that needs GDELT's own host, see test/news/live.test.ts), proxies, or
// what the adapters do with the error once it is thrown.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getOverNodeHttp, httpGet, httpTimeoutMs, HttpTimeout } from "../../src/news/http.js";

const TIMEOUT_MS = 300;

let open: Server[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  open.push(server);
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done(`http://127.0.0.1:${port}/quiet`);
    });
  });
}

afterEach(async () => {
  const servers = open;
  open = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  delete process.env["KAAVAL_HTTP_TIMEOUT_MS"];
});

describe("httpGet", () => {
  it("gives up on a host that accepts the connection and never answers", async () => {
    const url = await listen(() => {
      // No write and no end: this is the shape of the call that hung the engine.
    });
    const started = Date.now();

    await expect(httpGet(url, {}, TIMEOUT_MS)).rejects.toThrow(/timed out after 0.3 seconds/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("gives up on a host that sends headers and then stalls mid-body", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "999" });
      res.write('{"articles":');
    });
    const started = Date.now();

    await expect(httpGet(url, {}, TIMEOUT_MS)).rejects.toBeInstanceOf(HttpTimeout);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("returns the status and the body when the host answers normally", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("slow down");
    });

    await expect(httpGet(url, {}, TIMEOUT_MS)).resolves.toEqual({ status: 429, body: "slow down" });
  });

  it("bounds the node:http fallback too, which counts silence rather than the whole call", async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { "Content-Length": "999" });
      // A byte every fifth of a second keeps node's own socket timeout from ever firing.
      const drip = setInterval(() => res.write("."), TIMEOUT_MS / 3);
      res.on("close", () => clearInterval(drip));
    });
    const started = Date.now();

    await expect(getOverNodeHttp(url, {}, TIMEOUT_MS)).rejects.toBeInstanceOf(HttpTimeout);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("defaults to twenty seconds and takes KAAVAL_HTTP_TIMEOUT_MS when it is a positive number", () => {
    expect(httpTimeoutMs()).toBe(20_000);
    process.env["KAAVAL_HTTP_TIMEOUT_MS"] = "5000";
    expect(httpTimeoutMs()).toBe(5_000);
    process.env["KAAVAL_HTTP_TIMEOUT_MS"] = "not a number";
    expect(httpTimeoutMs()).toBe(20_000);
  });
});
