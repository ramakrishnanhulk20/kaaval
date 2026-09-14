import { BitgetRestClient, buildTools, loadConfig } from "@bitget-ai/bitget-agent-sdk";
import { BitgetError, type BitgetContext } from "../bitget/client.js";
import {
  accountUid,
  availableUsdt,
  optNum,
  pick,
  readOverview,
  reportedEquityUsdt,
  type Row,
  type Snapshot,
} from "./overview.js";

export interface BitgetCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface ConnectionOk {
  ok: true;
  uid: string | null;
  equityUsdt: number;
  positions: number;
  checkedAt: number;
}

export interface ConnectionFailed {
  ok: false;
  reason: string;
  retryable: boolean;
}

/** Either the account answered, or it did not and the reason is in plain words. */
export type ConnectionCheck = ConnectionOk | ConnectionFailed;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Account for the balances and positions, trade for the order verb.
 *
 * The order verb is here for one thing only: the SDK renders a dry-run preview of an
 * order through it without touching the network, which is how a plan shows a trader the
 * exact request Bitget would have received. A read-only surface still carries the verb,
 * and its safety layer refuses every write action through it.
 */
const DEFAULT_MODULES = "account,trade";

/**
 * A Bitget tool surface for one trader's key, read-only, always.
 *
 * There is no option here to turn readOnly off, and that is the design: this module is
 * the only place a customer's credentials are turned into a client, so a write path
 * cannot be opened by a caller passing the wrong flag. readOnly does not remove the
 * verbs, it puts every write action behind the SDK's one safety chokepoint, which
 * refuses before it looks at a credential or the network. A test in
 * test/tenant/credentials.test.ts places an order through this surface and shows it
 * refused, because that is the guarantee the whole product rests on.
 *
 * Credentials are passed in rather than read from the environment, because the engine's
 * own key lives in the environment and a trader's key must never be able to replace it.
 */
export function contextFor(creds: BitgetCredentials, opts?: { modules?: string }): BitgetContext {
  const config = loadConfig({
    apiKey: creds.apiKey,
    secretKey: creds.secretKey,
    passphrase: creds.passphrase,
    readOnly: true,
    modules: opts?.modules ?? DEFAULT_MODULES,
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
 * Does this key work, and what does it see? One read, and never a throw.
 *
 * The read is a single account_overview, the cheapest call that proves all three parts
 * of a Bitget credential at once: a wrong API key, a wrong secret and a wrong passphrase
 * all fail it, and an IP that is not on the key's allow list fails it too. It also
 * answers the two numbers a trader wants right after pasting a key, their equity and how
 * many positions Kaaval can see.
 *
 * Every failure comes back as a sentence a non-technical trader can act on, with
 * retryable saying whether trying again in a minute could help. Nothing here throws,
 * because the caller is a sign-in form and a stack trace is not an answer.
 *
 * surface is the read-only context to go through. It exists so a caller that already
 * built one does not build a second, and so the tests can put a stand-in Bitget behind
 * this function; left out, the credentials get their own context from contextFor, which
 * is the only read-only-by-construction way to make one.
 */
export async function checkConnection(
  creds: BitgetCredentials,
  surface?: BitgetContext,
): Promise<ConnectionCheck> {
  const missing = missingFields(creds);
  if (missing.length > 0) {
    return { ok: false, reason: `the ${missing.join(", ")} is missing`, retryable: false };
  }

  let snapshot: Snapshot;
  try {
    snapshot = await readOverview(surface ?? contextFor(creds));
  } catch (error) {
    return { ok: false, ...reasonForError(error) };
  }

  // The overview reports each section on its own, so a key Bitget refused comes back as
  // a successful call whose sections all failed. That is the usual shape of a wrong key,
  // which is why a failed assets section is read as a refusal here.
  const assetsFailure = snapshot.failures.find((failure) => failure.section === "assets");
  if (assetsFailure) {
    return { ok: false, ...reasonForMessage(assetsFailure.message) };
  }

  const equity = reportedEquityUsdt(snapshot);
  return {
    ok: true,
    uid: accountUid(snapshot),
    equityUsdt: equity ?? availableUsdt(snapshot),
    positions: countPositions(snapshot),
    checkedAt: Date.now(),
  };
}

/**
 * Open positions this key can see: futures positions with size on them, plus any rToken
 * the account holds on spot, which is a position to Kaaval even though Bitget files it
 * as a balance.
 */
function countPositions(snapshot: Snapshot): number {
  let count = 0;
  for (const row of snapshot.positionRows) {
    const qty = optNum(row, ["total", "size", "qty", "positionAmt", "available"]);
    if (qty !== null && Math.abs(qty) > 0) count += 1;
  }
  for (const row of snapshot.assetRows) {
    if (!isRTokenRow(row)) continue;
    const qty = optNum(row, ["available", "balance", "equity", "total"]);
    if (qty !== null && qty > 0) count += 1;
  }
  return count;
}

/** Bitget names every tokenized stock with an r prefix, rTSLA for TSLA, and no other coin does. */
export function isRTokenRow(row: Row): boolean {
  const coin = String(pick(row, ["coin", "coinName", "currency"]) ?? "");
  return /^r[A-Z0-9]{2,}$/.test(coin);
}

function missingFields(creds: BitgetCredentials): string[] {
  const missing: string[] = [];
  if (!creds.apiKey || creds.apiKey.trim() === "") missing.push("API key");
  if (!creds.secretKey || creds.secretKey.trim() === "") missing.push("secret key");
  if (!creds.passphrase || creds.passphrase.trim() === "") missing.push("passphrase");
  return missing;
}

/**
 * A thrown Bitget failure as one sentence.
 *
 * invoke wraps the SDK's error envelope, which carries a code from Bitget's own table
 * and the retryable flag the SDK worked out from it, in
 * reference/agent-hub/agent-sdk/src/utils/error-catalog.ts. The code is used when it is
 * there, because it is exact, and the message text is read only when it is not.
 */
/**
 * Bitget answers a classic-mode account with HTTP 400 and no error code, only this sentence.
 * Every reader here is a unified-account read, so the trader has one thing to do and the
 * message says it; seen live on Ram's own account on 14 September 2026.
 */
const CLASSIC_MODE =
  "This Bitget account is in Classic mode. Kaaval reads through the Unified Trading Account API, so switch the account to UTA in the Bitget app (Assets, Unified Trading Account, upgrade), create the read-only key again, and connect once more.";

function classicMode(text: string): { reason: string; retryable: boolean } | null {
  return /classic account mode/i.test(text) ? { reason: CLASSIC_MODE, retryable: false } : null;
}

function reasonForError(error: unknown): { reason: string; retryable: boolean } {
  const classic = classicMode((error as Error | undefined)?.message ?? "");
  if (classic) return classic;
  if (error instanceof BitgetError) {
    const envelope = (error.payload as { error?: Record<string, unknown> } | undefined)?.error;
    if (envelope) {
      const code = envelope["code"] === undefined ? "" : String(envelope["code"]);
      const message = String(envelope["message"] ?? "");
      const fromMessage = classicMode(message);
      if (fromMessage) return fromMessage;
      const known = reasonForCode(code);
      if (known) return known;
      const guessed = reasonForMessage(message);
      // The SDK's own retryable flag beats a guess from the text whenever it is there.
      const retryable =
        typeof envelope["retryable"] === "boolean" ? (envelope["retryable"] as boolean) : guessed.retryable;
      return { reason: guessed.reason, retryable };
    }
  }
  return reasonForMessage((error as Error | undefined)?.message ?? "");
}

/**
 * Bitget's error codes, grouped into the four things a trader can do something about.
 * The codes are the SDK's catalog; the wording is ours, because "signature parameter
 * verification failed" tells a trader nothing.
 */
function reasonForCode(code: string): { reason: string; retryable: boolean } | null {
  switch (code) {
    case "40001":
    case "40006":
    case "40036":
      return { reason: BAD_KEY, retryable: false };
    case "40002":
    case "40003":
    case "40009":
    case "40017":
      return { reason: BAD_SECRET, retryable: false };
    case "40018":
    case "40042":
    case "25620":
      return { reason: NOT_ALLOWED, retryable: false };
    case "40008":
      return {
        reason: "Bitget rejected the request time. The clock on this machine is out of step with Bitget's.",
        retryable: true,
      };
    case "429":
    case "25004":
      return { reason: RATE_LIMITED, retryable: true };
    case "500":
    case "502":
    case "503":
    case "504":
    case "25000":
    case "25001":
    case "25003":
      return { reason: "Bitget did not answer. This is their side, not the key.", retryable: true };
    case "25245":
      return {
        reason: "That account is not in unified trading mode, which is the only mode this reads.",
        retryable: false,
      };
    default:
      return null;
  }
}

const BAD_KEY = "Bitget does not recognise that API key. Check it was copied whole and is still active.";
const BAD_SECRET = "The secret key or the passphrase does not match that API key.";
const BAD_CREDENTIALS =
  "Bitget refused those credentials. One of the three is wrong: the API key, the secret key or the passphrase.";
const NOT_ALLOWED =
  "That API key is not allowed to make this read from this machine. Check its permissions and its IP allow list.";
const RATE_LIMITED = "Bitget is rate limiting this key right now. Wait a moment and try again.";
const UNREACHABLE = "Bitget could not be reached. This is the network, not the key.";

/**
 * The same mapping from the message text alone.
 *
 * The account_overview verb collapses a failed section to its message and drops the
 * code, so on that path there is nothing else to read. The matches are deliberately
 * broad, and the fallback says plainly that the reason is unknown rather than guessing.
 */
function reasonForMessage(message: string): { reason: string; retryable: boolean } {
  // A failed account section arrives here as bare text with no code, which is the path a
  // classic-mode account actually takes.
  const classic = classicMode(message);
  if (classic) return classic;
  const text = message.toLowerCase();
  const code = /\b(4\d{4}|2\d{4}|429|50[0-4])\b/.exec(text)?.[1];
  const byCode = code === undefined ? null : reasonForCode(code);
  if (byCode) return byCode;

  const namesKey = text.includes("apikey") || text.includes("api key") || text.includes("access_key");
  const namesSecret = text.includes("passphrase") || text.includes("password") || text.includes("sign");
  // Bitget's own text for a wrong passphrase is "apikey/password is incorrect", which
  // names both halves and tells you nothing about which one is wrong. Saying so is more
  // use to a trader than picking one of the two and sounding certain.
  if (namesKey && namesSecret) return { reason: BAD_CREDENTIALS, retryable: false };
  if (namesSecret) return { reason: BAD_SECRET, retryable: false };
  if (namesKey || text.includes("credential")) return { reason: BAD_KEY, retryable: false };
  if (text.includes(" ip") || text.startsWith("ip") || text.includes("permission") || text.includes("forbidden")) {
    return { reason: NOT_ALLOWED, retryable: false };
  }
  if (text.includes("frequent") || text.includes("rate limit") || text.includes("too many")) {
    return { reason: RATE_LIMITED, retryable: true };
  }
  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("econn")
  ) {
    return { reason: UNREACHABLE, retryable: true };
  }
  return {
    reason: `Bitget refused the read and gave no reason we recognise: ${message || "no message"}`,
    retryable: false,
  };
}

/** The same budget src/bitget/client.ts gives a market read, so a tenant read cannot outlive one. */
function timeoutMs(): number {
  const raw = process.env["KAAVAL_BITGET_TIMEOUT_MS"];
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return parsed;
}
