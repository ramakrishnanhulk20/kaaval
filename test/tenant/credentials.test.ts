// What a pasted key gets told: the happy answer, and one plain sentence for every class
// of Bitget failure, through the SDK's real error envelope. Does NOT cover a live Bitget
// call with a real key (none exists yet), the sign-in form that will call this, or where
// the key is stored: seal.test.ts covers the sealing.
import { AuthenticationError, BitgetApiError, NetworkError, RateLimitError } from "@bitget-ai/bitget-agent-sdk";
import { describe, expect, it } from "vitest";
import { invoke } from "../../src/bitget/client.js";
import { checkConnection, contextFor, type BitgetCredentials } from "../../src/tenant/credentials.js";
import { fakeTenant, type FakeTenantSpec } from "./fake-tenant.js";

const CREDS: BitgetCredentials = { apiKey: "bg-key", secretKey: "bg-secret", passphrase: "bg-pass" };

/** The fake stands in for the Bitget surface. Everything under it, safeInvoke and the
 * SDK's error envelope included, is the real thing. */
async function check(spec: FakeTenantSpec = {}) {
  const tenant = fakeTenant(spec);
  return { result: await checkConnection(CREDS, tenant), tenant };
}

describe("checkConnection", () => {
  it("answers with the account's equity, its positions and its uid", async () => {
    const { result, tenant } = await check();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.equityUsdt).toBeCloseTo(7246.44, 2);
    // One short TSLA perpetual and one rTSLA spot holding.
    expect(result.positions).toBe(2);
    expect(result.uid).toBe("9182736450");
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(tenant.calls).toHaveLength(1);
    expect(tenant.calls[0]?.tool).toBe("account_overview");
  });

  it("refuses an empty credential without calling Bitget at all", async () => {
    const tenant = fakeTenant();
    const result = await checkConnection({ apiKey: "", secretKey: "s", passphrase: "" }, tenant);
    expect(result).toEqual({ ok: false, reason: "the API key, passphrase is missing", retryable: false });
    expect(tenant.calls).toHaveLength(0);
  });

  it("names a wrong API key", async () => {
    const { result } = await check({ throws: new BitgetApiError("Invalid ACCESS_KEY", { code: "40006" }) });
    expect(result).toEqual({
      ok: false,
      reason: "Bitget does not recognise that API key. Check it was copied whole and is still active.",
      retryable: false,
    });
  });

  it("names the credentials when Bitget will not say which of the three is wrong", async () => {
    const { result } = await check({
      throws: new AuthenticationError("apikey/password is incorrect", "Check API key, secret, passphrase."),
    });
    expect(result).toEqual({
      ok: false,
      reason:
        "Bitget refused those credentials. One of the three is wrong: the API key, the secret key or the passphrase.",
      retryable: false,
    });
  });

  it("names the passphrase when that is what Bitget named", async () => {
    const { result } = await check({
      throws: new BitgetApiError("Signature verification failed", { code: "40009" }),
    });
    expect(result).toEqual({
      ok: false,
      reason: "The secret key or the passphrase does not match that API key.",
      retryable: false,
    });
  });

  it("names an IP that is not allowed", async () => {
    const { result } = await check({
      throws: new BitgetApiError("API key permission or IP restriction error", { code: "40018" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("IP allow list");
    expect(result.retryable).toBe(false);
  });

  it("marks a rate limit, an outage and a dead network as worth retrying", async () => {
    const limited = await check({ throws: new RateLimitError("Operations too frequent", "25004") });
    expect(limited.result).toEqual({
      ok: false,
      reason: "Bitget is rate limiting this key right now. Wait a moment and try again.",
      retryable: true,
    });

    const down = await check({ throws: new BitgetApiError("HTTP 503 from Bitget", { code: "503" }) });
    expect(down.result).toEqual({
      ok: false,
      reason: "Bitget did not answer. This is their side, not the key.",
      retryable: true,
    });

    const offline = await check({ throws: new NetworkError("fetch failed", "(composite) account_overview") });
    expect(offline.result.ok).toBe(false);
    if (offline.result.ok) return;
    expect(offline.result.retryable).toBe(true);
  });

  it("reads a refusal that arrives as a failed section, where the code is gone", async () => {
    const { result } = await check({ sectionErrors: { assets: "apikey/password is incorrect" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Bitget refused those credentials");
    expect(result.retryable).toBe(false);
  });

  it("says plainly when it does not recognise the refusal", async () => {
    const { result } = await check({ sectionErrors: { assets: "something nobody has seen before" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no reason we recognise");
    expect(result.retryable).toBe(false);
  });

  it("falls back to the account's free USDT when no total equity is published", async () => {
    const { result } = await check({
      assets: [{ coin: "USDT", available: "250.5", balance: "250.5" }],
      positions: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.equityUsdt).toBeCloseTo(250.5, 2);
    expect(result.positions).toBe(0);
  });
});

describe("contextFor", () => {
  it("builds a read-only surface and offers no way to turn that off", () => {
    const ctx = contextFor(CREDS);
    expect((ctx.config as { readOnly?: boolean }).readOnly).toBe(true);
    expect((ctx.config as { paperTrading?: boolean }).paperTrading).toBe(false);
    expect(ctx.tools.has("account_overview")).toBe(true);
    expect(ctx.tools.has("order")).toBe(true);
  });

  it("refuses a real order through that surface, before any network call", async () => {
    const ctx = contextFor(CREDS);
    await expect(
      invoke(ctx, "order", {
        action: "place",
        category: "SPOT",
        symbol: "RTSLAUSDT",
        side: "buy",
        orderType: "limit",
        qty: "1",
        price: "400",
      }),
    ).rejects.toThrow(/readOnly/i);
  });

  it("still previews that same order, which is all a plan ever needs", async () => {
    const ctx = contextFor(CREDS);
    const preview = (await invoke(ctx, "order", {
      action: "place",
      category: "SPOT",
      symbol: "RTSLAUSDT",
      side: "buy",
      orderType: "limit",
      qty: "1",
      price: "400",
      dryRun: true,
    })) as Record<string, unknown>;
    expect(preview["dryRun"]).toBe(true);
    expect(preview["operationId"]).toBe("placeOrder");
  });
});
