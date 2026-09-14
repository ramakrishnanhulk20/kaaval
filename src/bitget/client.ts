import {
  BitgetRestClient,
  buildTools,
  loadConfig,
  safeInvoke,
  type ToolContext,
  type ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";

export interface BitgetContext {
  config: unknown;
  client: unknown;
  tools: Map<string, unknown>;
}

/**
 * Thrown when a Bitget tool call comes back with ok:false. Carries the tool name,
 * the arguments we sent and the SDK's error payload so a caller can log the whole
 * failure without re-running the call.
 */
export class BitgetError extends Error {
  constructor(
    public readonly tool: string,
    public readonly args: Record<string, unknown>,
    public readonly payload: unknown,
  ) {
    super(`Bitget tool "${tool}" failed: ${describe(payload)}`);
    this.name = "BitgetError";
  }
}

function describe(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    return JSON.stringify((payload as { error: unknown }).error);
  }
  return JSON.stringify(payload);
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * How long one Bitget request may take, from KAAVAL_BITGET_TIMEOUT_MS.
 *
 * The SDK retries a transient failure twice on top of the first try, and every read in
 * Kaaval is a GET, so one stuck host can cost three of these before the call comes back.
 * A tick makes about forty five reads, which is why the engine has its own watchdog on
 * top of this number rather than trusting it alone.
 */
function timeoutMs(): number {
  const raw = process.env["KAAVAL_BITGET_TIMEOUT_MS"];
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Build the Bitget tool surface we read the market through.
 *
 * Read-only by default so no code path in Kaaval can place an order by accident.
 * Credentials are never passed in here: the SDK picks BITGET_API_KEY,
 * BITGET_SECRET_KEY and BITGET_PASSPHRASE out of the environment itself, and every
 * market call this module makes is public and works with none of them set.
 */
export function createBitget(opts?: {
  readOnly?: boolean;
  paperTrading?: boolean;
  modules?: string;
}): BitgetContext {
  const readOnly = opts?.readOnly ?? true;
  const paperTrading = opts?.paperTrading ?? false;
  if (readOnly && paperTrading) {
    throw new Error("readOnly and paperTrading are mutually exclusive in the Bitget SDK");
  }
  const config = loadConfig({
    modules: opts?.modules ?? "market",
    readOnly,
    paperTrading,
    timeoutMs: timeoutMs(),
  });
  const client = new BitgetRestClient(config);
  const tools = new Map<string, unknown>();
  for (const tool of buildTools(config)) {
    tools.set(tool.name, tool);
  }
  return { config, client, tools };
}

/**
 * Call one Bitget tool and return its data, or throw BitgetError.
 *
 * safeInvoke never throws: it resolves to a tagged union and a failed call looks
 * exactly like a successful one until you read .ok. Every caller in Kaaval goes
 * through here so that a Bitget failure is a thrown error like any other, instead
 * of an undefined that surfaces three layers later as NaN.
 */
export async function invoke<T = unknown>(
  ctx: BitgetContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<T> {
  const spec = ctx.tools.get(tool) as ToolSpec | undefined;
  if (!spec) {
    throw new BitgetError(tool, args, { error: `tool "${tool}" is not on the built surface` });
  }
  const context = { config: ctx.config, client: ctx.client } as ToolContext;
  const res = await safeInvoke(spec, args, context);
  if (!res.ok) {
    throw new BitgetError(tool, args, res);
  }
  return res.data as T;
}
