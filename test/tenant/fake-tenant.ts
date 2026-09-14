import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BitgetContext } from "../../src/bitget/client.js";

/**
 * A stand-in for one trader's private Bitget surface: account_overview, position and
 * order. It records every call, which is how the tenant tests prove that a plan never
 * sends anything: the assertion is on the calls the code actually made, not on a promise
 * that it would not.
 *
 * The order tool behaves like the SDK's safety layer. A dryRun preview is answered from
 * the arguments without a network hop, and anything else throws, which is what a
 * read-only surface does with a write.
 */

export type Row = Record<string, unknown>;

export interface FakeTenantSpec {
  /** The assets section, either a bare list of coin rows or the wrapper with totals. */
  assets?: unknown;
  positions?: Row[];
  settings?: Row;
  /** Sections that come back ok:false, the shape a wrong key produces. */
  sectionErrors?: Record<string, string>;
  /** Thrown by account_overview before any section runs, for the transport failures. */
  throws?: unknown;
}

export interface FakeTenant extends BitgetContext {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

export const assetsFixture = fixture<unknown>("account-assets.json");
export const positionsFixture = fixture<Row[]>("positions.json");
export const settingsFixture = fixture<Row>("account-settings.json");

export function fakeTenant(spec: FakeTenantSpec = {}): FakeTenant {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const assets = spec.assets ?? assetsFixture;
  const positions = spec.positions ?? positionsFixture;
  const settings = spec.settings ?? settingsFixture;
  const errors = spec.sectionErrors ?? {};

  const section = (key: string, data: unknown): Record<string, unknown> =>
    errors[key] === undefined ? { ok: true, data } : { ok: false, error: errors[key] };

  const overview = {
    name: "account_overview",
    method: "GET",
    path: "(composite)",
    handler: async (args: Record<string, unknown>) => {
      calls.push({ tool: "account_overview", args });
      if (spec.throws !== undefined) throw spec.throws;
      const data: Record<string, unknown> = {
        assets: section("assets", assets),
        settings: section("settings", settings),
        fundingAssets: section("fundingAssets", []),
      };
      if (args["category"] !== undefined) data["positions"] = section("positions", positions);
      return { endpoint: "(composite) account_overview", requestTime: "0", data };
    },
  };

  const position = {
    name: "position",
    method: "GET",
    path: "(composite)",
    handler: async (args: Record<string, unknown>) => {
      calls.push({ tool: "position", args });
      return { endpoint: "(composite) position", requestTime: "0", data: positions };
    },
  };

  const order = {
    name: "order",
    method: "POST",
    path: "(composite)",
    handler: async (args: Record<string, unknown>) => {
      calls.push({ tool: "order", args });
      if (args["dryRun"] !== true) {
        throw new Error("readOnly mode: this surface refuses every write");
      }
      const { dryRun: _dryRun, action: _action, ...rest } = args;
      return {
        endpoint: "(composite) order",
        requestTime: "0",
        data: {
          dryRun: true,
          operationId: "placeOrder",
          method: "POST",
          path: "/api/v3/trade/place-order",
          riskLevel: "write",
          wouldSend: rest,
        },
      };
    },
  };

  return {
    config: {},
    client: {},
    tools: new Map<string, unknown>([
      ["account_overview", overview],
      ["position", position],
      ["order", order],
    ]),
    calls,
  };
}

/**
 * Every call that would have changed something on Bitget. A place, cancel, modify or
 * close that is not a dry run is a write; every read verb and every dry run is not.
 */
export function writeCalls(tenant: FakeTenant): Array<{ tool: string; args: Record<string, unknown> }> {
  const writeActions = new Set(["place", "cancel", "modify", "cancelAll", "countdownCancel", "close", "closeAll"]);
  return tenant.calls.filter((call) => {
    const action = String(call.args["action"] ?? "");
    return writeActions.has(action) && call.args["dryRun"] !== true;
  });
}

export function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
