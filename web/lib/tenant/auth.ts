import { PrivyClient } from "@privy-io/node";
import { z } from "zod";
import { withDb, type Db } from "./db";
import { tenantEnv } from "./env";

/**
 * Who is asking, proved on the server every time.
 *
 * The browser holds a short lived access token and hands it to a server action as an
 * argument. Nothing here trusts a user id that arrives from the browser: the id used for
 * every read and write below is the one that comes out of verifying the token, so a
 * caller cannot name somebody else's account by editing a request.
 */

export interface VerifiedUser {
  userId: string;
}

/** The one thing this module needs from Privy, so a test can stand in for it. */
export interface Verifier {
  verify(token: string): Promise<VerifiedUser>;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// A Privy access token is a JWT, so it is three dot separated chunks and nothing else.
// Checking the shape first keeps a pasted password or an empty string from becoming a
// network call, and a token is never put in a message or a log at any point below.
const tokenSchema = z
  .string()
  .min(20, "that sign-in has no token in it")
  .max(4096, "that sign-in token is too long to be real")
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "that sign-in token is not shaped like a Privy token");

let client: PrivyClient | null = null;

function privyClient(): PrivyClient {
  if (client) return client;
  const env = tenantEnv();
  if (env.privyAppId === null || env.privyAppSecret === null) {
    throw new AuthError("sign-in is not configured on this host");
  }
  client = new PrivyClient({ appId: env.privyAppId, appSecret: env.privyAppSecret });
  return client;
}

/** The real verifier: Privy's own server SDK, checked against this app's id and secret. */
export function privyVerifier(): Verifier {
  return {
    async verify(token: string): Promise<VerifiedUser> {
      const claims = await privyClient().utils().auth().verifyAccessToken(token);
      if (typeof claims.user_id !== "string" || claims.user_id.trim() === "") {
        throw new AuthError("that sign-in was accepted but named no user");
      }
      return { userId: claims.user_id };
    },
  };
}

/**
 * Turns an access token into the user id every other call in this layer is keyed on, and
 * makes sure that user has a row.
 *
 * The id is Privy's DID. It is a name in Privy's own namespace, so it can never collide
 * with a connection id or a plan id, which are database uuids: knowing one of those ids
 * is never the same as being a user.
 *
 * Throws AuthError when the token is missing, malformed, expired or not ours. Every
 * refusal is logged with the reason and without the token.
 */
export async function requireUser(token: string, verifier: Verifier = privyVerifier()): Promise<VerifiedUser> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "that sign-in token cannot be read";
    console.warn(`auth refused: ${reason}`);
    throw new AuthError(`${reason}. Sign in again.`);
  }

  let user: VerifiedUser;
  try {
    user = await verifier.verify(parsed.data);
  } catch (error) {
    console.warn(`auth refused: ${(error as Error).name}`);
    throw new AuthError("that sign-in has expired or is not valid here. Sign in again.");
  }

  await withDb((db) => upsertUser(db, user.userId));
  return user;
}

/** First sight of a trader creates their row; every sight after it changes nothing. */
export async function upsertUser(db: Db, userId: string): Promise<void> {
  await db.query("insert into users (id) values ($1) on conflict (id) do nothing", [userId]);
}
