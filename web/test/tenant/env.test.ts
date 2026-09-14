import { describe, expect, it } from "vitest";
import { parseTenantEnv, tenantConfigured, TenantEnvError } from "../../lib/tenant/env";

// The settings the account area reads, and what it says when they are not there. It does not
// cover what a real Privy app id or a real connection string does when it is used: these are
// shape checks only, made against an environment written here rather than the process one, so
// nothing in this file can leak into another test.

describe("the account settings", () => {
  it("says which settings are missing instead of throwing", () => {
    const env = parseTenantEnv({});
    const status = tenantConfigured(env);

    expect(status.ready).toBe(false);
    expect(status.missing).toEqual([
      "NEXT_PUBLIC_PRIVY_APP_ID",
      "PRIVY_APP_SECRET",
      "DATABASE_URL",
      "KAAVAL_KEY_SEAL_HEX",
    ]);
    expect(status.signIn).toBe(false);
    expect(status.signing).toBe(false);
  });

  it("reads an empty string as not set, the way a deploy panel means it", () => {
    const status = tenantConfigured(parseTenantEnv({ DATABASE_URL: "   ", ANTHROPIC_API_KEY: "" }));

    expect(status.database).toBe(false);
    expect(status.models).toBe(false);
  });

  it("throws at once when a setting is there but malformed", () => {
    expect(() => parseTenantEnv({ KAAVAL_KEY_SEAL_HEX: "not hex" })).toThrow(TenantEnvError);
    expect(() => parseTenantEnv({ DATABASE_URL: "mysql://somewhere/db" })).toThrow(
      /postgres connection string/,
    );
    expect(() => parseTenantEnv({ KAAVAL_PLAN_KEY_PEM: "just some text" })).toThrow(/PEM private key/);
  });

  it("is ready when the four it needs are set, and defaults the run count to one", () => {
    const env = parseTenantEnv({
      NEXT_PUBLIC_PRIVY_APP_ID: "app-id",
      PRIVY_APP_SECRET: "app-secret",
      DATABASE_URL: "postgresql://user:pass@host/db?sslmode=require",
      KAAVAL_KEY_SEAL_HEX: "a".repeat(64),
    });

    expect(tenantConfigured(env).ready).toBe(true);
    expect(env.ensembleRuns).toBe(1);
    expect(parseTenantEnv({ KAAVAL_WEB_ENSEMBLE_RUNS: "3" }).ensembleRuns).toBe(3);
  });
});
