"use server";

import { requireUser } from "@/lib/tenant/auth";
import {
  connect,
  listConnections,
  removeConnection,
  type ConnectInput,
  type ConnectionRow,
} from "@/lib/tenant/connections";
import { tenantConfigured } from "@/lib/tenant/env";
import { getPlan, listPlans, planTonight, type PlanOutcome, type PlanRow, type StoredPlan } from "@/lib/tenant/plans";

/**
 * Everything the two account screens can ask the server to do.
 *
 * The access token is an argument, not a cookie the browser sends by itself, and the user
 * id is whatever comes out of verifying it. Nothing below reads a user id from the
 * request, so no caller can act on another trader's connection by naming its id.
 */

export interface ActionFailure {
  ok: false;
  reason: string;
}

export type ConnectActionResult =
  | { ok: true; connectionId: string; uid: string | null; equityUsdt: number; positions: number }
  | (ActionFailure & { retryable: boolean });

export type AccountActionResult = { ok: true; connections: ConnectionRow[]; plans: PlanRow[] } | ActionFailure;

export type PlanActionResult = PlanOutcome | ActionFailure;

export type RemoveActionResult = { ok: true; removed: boolean } | ActionFailure;

export type PlanDetailResult = { ok: true; plan: StoredPlan | null } | ActionFailure;

/** The one place a failure in this layer becomes a sentence with a next step in it. */
function failure(error: unknown): ActionFailure {
  const named = error as Error;
  if (named.name === "AuthError") return { ok: false, reason: named.message };
  if (named.name === "DbError") {
    return { ok: false, reason: "the account database is not reachable from this host right now. Try again in a minute." };
  }
  console.error(`account action failed: ${named.name}: ${named.message}`);
  return { ok: false, reason: "something went wrong on our side. Try again, and if it keeps failing the server log has the detail." };
}

function notReady(): ActionFailure | null {
  const status = tenantConfigured();
  if (status.ready) return null;
  return {
    ok: false,
    reason: `the account area is not fully configured on this host: ${status.missing.join(", ")} still to set.`,
  };
}

export async function connectAction(token: string, input: ConnectInput): Promise<ConnectActionResult> {
  const blocked = notReady();
  if (blocked) return { ...blocked, retryable: false };
  try {
    const { userId } = await requireUser(token);
    const result = await connect(userId, input);
    return result.ok ? result : { ok: false, reason: result.reason, retryable: result.retryable };
  } catch (error) {
    return { ...failure(error), retryable: false };
  }
}

export async function accountAction(token: string): Promise<AccountActionResult> {
  const blocked = notReady();
  if (blocked) return blocked;
  try {
    const { userId } = await requireUser(token);
    const [connections, plans] = await Promise.all([listConnections(userId), listPlans(userId)]);
    return { ok: true, connections, plans };
  } catch (error) {
    return failure(error);
  }
}

export async function planAction(token: string, connectionId: string): Promise<PlanActionResult> {
  const blocked = notReady();
  if (blocked) return blocked;
  try {
    const { userId } = await requireUser(token);
    return await planTonight(userId, connectionId);
  } catch (error) {
    return failure(error);
  }
}

export async function removeAction(token: string, connectionId: string): Promise<RemoveActionResult> {
  const blocked = notReady();
  if (blocked) return blocked;
  try {
    const { userId } = await requireUser(token);
    return { ok: true, removed: await removeConnection(userId, connectionId) };
  } catch (error) {
    return failure(error);
  }
}

export async function planDetailAction(token: string, planId: string): Promise<PlanDetailResult> {
  const blocked = notReady();
  if (blocked) return blocked;
  try {
    const { userId } = await requireUser(token);
    return { ok: true, plan: await getPlan(userId, planId) };
  } catch (error) {
    return failure(error);
  }
}
