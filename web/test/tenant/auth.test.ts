import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, requireUser, type Verifier } from "../../lib/tenant/auth";
import { freshDatabase, type Harness } from "./harness";

// Turning an access token into a user id, against a real database and a stand-in verifier. It
// does not cover Privy itself: whether a token signature checks out is Privy's SDK to answer,
// and this file only proves what happens on either side of that answer.

const TOKEN = `${"a".repeat(30)}.${"b".repeat(40)}.${"c".repeat(43)}`;

const accepts: Verifier = {
  verify: async () => ({ userId: "did:privy:trader-one" }),
};

const refuses: Verifier = {
  verify: async () => {
    throw new Error("token expired");
  },
};

describe("requireUser", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await freshDatabase();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("gives back the verified id and creates the row once", async () => {
    const first = await requireUser(TOKEN, accepts);
    const second = await requireUser(TOKEN, accepts);

    expect(first.userId).toBe("did:privy:trader-one");
    expect(second.userId).toBe(first.userId);

    const { rows } = await harness.db.query<{ id: string }>("select id from users");
    expect(rows).toHaveLength(1);
  });

  it("refuses anything that is not shaped like a token, without calling out", async () => {
    await expect(requireUser("", accepts)).rejects.toBeInstanceOf(AuthError);
    await expect(requireUser(`bearer ${"x".repeat(40)}`, accepts)).rejects.toThrow(/not shaped like/);

    const { rows } = await harness.db.query<{ id: string }>("select id from users");
    expect(rows).toHaveLength(0);
  });

  it("refuses a token the verifier rejects, and says to sign in again", async () => {
    await expect(requireUser(TOKEN, refuses)).rejects.toThrow(/Sign in again/);

    const { rows } = await harness.db.query<{ id: string }>("select id from users");
    expect(rows).toHaveLength(0);
  });
});
