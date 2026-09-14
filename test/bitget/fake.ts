import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BitgetContext } from "../../src/bitget/client.js";

/**
 * A stand-in for the Bitget tool surface. It answers the same market tool the real
 * SDK builds, so the code under test runs its own argument building, paging and
 * parsing untouched, and only the network hop is replaced. Payloads come from the
 * recorded responses in test/fixtures wherever the shape matters.
 */
export type FakeHandler = (args: Record<string, unknown>) => unknown;

export interface FakeBitget extends BitgetContext {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

export function fakeBitget(handlers: Record<string, FakeHandler>): FakeBitget {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const spec = {
    name: "market",
    method: "GET",
    path: "(fake)",
    handler: async (args: Record<string, unknown>) => {
      calls.push({ tool: "market", args });
      const action = String(args["action"]);
      const handler = handlers[action];
      if (!handler) {
        throw new Error(`fake Bitget has no handler for action ${action}`);
      }
      return { endpoint: `fake:${action}`, requestTime: "0", data: handler(args) };
    },
  };
  return {
    config: {},
    client: {},
    tools: new Map<string, unknown>([["market", spec]]),
    calls,
  };
}

export function fixture<T = unknown>(name: string): T {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function fixtureData<T = unknown>(name: string): T {
  return fixture<{ data: T }>(name).data;
}
