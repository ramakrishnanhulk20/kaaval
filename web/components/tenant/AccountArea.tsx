"use client";

import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  accountAction,
  planAction,
  removeAction,
  type AccountActionResult,
} from "@/app/(tenant)/actions";
import type { ConnectionRow } from "@/lib/tenant/connections";
import type { PlanRow } from "@/lib/tenant/plans";
import { usdt, utcDayTime } from "@/lib/format";

/**
 * The trader's own connections and the plans made for them.
 *
 * Every number here is read from the database for this signed-in trader at the moment the
 * page loads. There is no seeded list and no placeholder row: an account with nothing
 * connected says so.
 */

type Busy = { kind: "plan" | "remove"; connectionId: string } | null;

type GetToken = () => Promise<string | null>;

const EXPIRED = "your sign-in has expired. Sign out and in again.";

/** One read of this trader's connections and plans, with no state of its own. */
async function readAccount(getAccessToken: GetToken): Promise<AccountActionResult> {
  const token = await getAccessToken();
  if (token === null) return { ok: false, reason: EXPIRED };
  return await accountAction(token);
}

export function AccountArea() {
  const { getAccessToken } = usePrivy();
  const [data, setData] = useState<AccountActionResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "gain" | "loss"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setData(await readAccount(getAccessToken));
  }, [getAccessToken]);

  // The read needs a token that only exists in this browser, so it happens here rather than
  // on the server. The answer is applied in the callback, and dropped if the trader has
  // already left the page.
  useEffect(() => {
    let alive = true;
    void readAccount(getAccessToken).then((answer) => {
      if (alive) setData(answer);
    });
    return () => {
      alive = false;
    };
  }, [getAccessToken]);

  const makePlan = async (connectionId: string): Promise<void> => {
    setBusy({ kind: "plan", connectionId });
    setMessage(null);
    const token = await getAccessToken();
    if (token === null) {
      setMessage({ tone: "loss", text: EXPIRED });
      setBusy(null);
      return;
    }
    const answer = await planAction(token, connectionId);
    setBusy(null);
    if (answer.ok) {
      setMessage({
        tone: "gain",
        text: answer.reused
          ? "That plan was made in the last five minutes, so this is the same one."
          : "The plan is ready.",
      });
      await load();
    } else {
      setMessage({ tone: "loss", text: answer.reason });
    }
  };

  const remove = async (connectionId: string): Promise<void> => {
    setBusy({ kind: "remove", connectionId });
    setMessage(null);
    const token = await getAccessToken();
    if (token === null) {
      setMessage({ tone: "loss", text: EXPIRED });
      setBusy(null);
      return;
    }
    const answer = await removeAction(token, connectionId);
    setBusy(null);
    setConfirming(null);
    if (answer.ok) {
      setMessage({ tone: "gain", text: "That key and every plan made with it are gone." });
      await load();
    } else {
      setMessage({ tone: "loss", text: answer.reason });
    }
  };

  if (data === null) {
    return (
      <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
        <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
        Reading your account
      </p>
    );
  }

  if (!data.ok) {
    return (
      <div className="border-l border-loss pl-4">
        <p className="font-mono text-[10px] tracking-[0.2em] text-loss uppercase">This did not load</p>
        <p className="mt-2 max-w-[60ch] font-mono text-[12px] leading-relaxed text-ink/80">{data.reason}</p>
        <button
          type="button"
          onClick={() => {
            setData(null);
            void load();
          }}
          className="mt-4 font-mono text-[11px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      {message === null ? null : (
        <p
          className={`mb-8 border-l pl-4 font-mono text-[12px] leading-relaxed ${
            message.tone === "gain" ? "border-gain text-gain" : "border-loss text-loss"
          }`}
        >
          {message.text}
        </p>
      )}

      <h2 className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Your keys</h2>

      {data.connections.length === 0 ? (
        <p className="mt-6 max-w-[60ch] text-[15px] leading-relaxed text-ink/60">
          Nothing connected yet.{" "}
          <Link href="/connect" className="text-ink underline decoration-amber underline-offset-4">
            Connect a read-only key
          </Link>{" "}
          and Kaaval will plan tonight against it.
        </p>
      ) : (
        <ul className="mt-6">
          {data.connections.map((connection) => (
            <li key={connection.id} className="border-t border-hair py-8">
              <ConnectionCard
                connection={connection}
                plans={data.plans.filter((plan) => plan.connectionId === connection.id)}
                busy={busy}
                confirming={confirming === connection.id}
                onPlan={() => {
                  void makePlan(connection.id);
                }}
                onAskRemove={() => {
                  setConfirming(confirming === connection.id ? null : connection.id);
                }}
                onRemove={() => {
                  void remove(connection.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-20 font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Every plan so far</h2>
      {data.plans.length === 0 ? (
        <p className="mt-6 max-w-[60ch] text-[15px] leading-relaxed text-ink/60">
          No plan has been made on this account yet.
        </p>
      ) : (
        <ul className="mt-6">
          {data.plans.map((plan) => (
            <li key={plan.id} className="border-t border-hair">
              <Link
                href={`/account/plans/${plan.id}`}
                className="flex flex-col gap-1 py-4 font-mono text-[12px] transition-colors duration-200 hover:text-amber sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span className="w-44 shrink-0 text-ink/80">{utcDayTime(new Date(plan.ts).getTime())} UTC</span>
                <span className="w-28 shrink-0 text-dim">{plan.window}</span>
                <span className="min-w-0 flex-1 break-words text-dim">{plan.label}</span>
                <span className={plan.signed ? "text-gain" : "text-dim"}>
                  {plan.signed ? "signed" : "not signed"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CardProps {
  connection: ConnectionRow;
  plans: PlanRow[];
  busy: Busy;
  confirming: boolean;
  onPlan: () => void;
  onAskRemove: () => void;
  onRemove: () => void;
}

function ConnectionCard({ connection, plans, busy, confirming, onPlan, onAskRemove, onRemove }: CardProps) {
  const planning = busy?.kind === "plan" && busy.connectionId === connection.id;
  const removing = busy?.kind === "remove" && busy.connectionId === connection.id;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3
          className="min-w-0 font-display font-extrabold break-words text-ink"
          style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", letterSpacing: "-0.03em" }}
        >
          {connection.label}
        </h3>
        <p className="font-mono text-[11px] tracking-[0.14em] text-dim">
          {connection.status === "ok" ? "reading fine" : connection.status}
          <span className="text-ink/25"> / </span>
          {String(plans.length)} plans
        </p>
      </div>

      <dl className="mt-4 font-mono text-[12px]">
        <Line label="Account" value={connection.uid ?? "not reported by Bitget"} />
        <Line
          label="Equity"
          value={connection.equityUsdt === null ? "not read yet" : `${usdt(connection.equityUsdt)} USDT`}
        />
        <Line label="Positions" value={connection.positions === null ? "not read yet" : String(connection.positions)} />
        <Line
          label="Last read"
          value={
            connection.checkedAt === null
              ? "never"
              : `${utcDayTime(new Date(connection.checkedAt).getTime())} UTC`
          }
        />
      </dl>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onPlan}
          disabled={planning || removing}
          className="group inline-flex items-center gap-3 rounded-[8px] border border-ink/70 px-5 py-3 font-mono text-[11px] tracking-[0.22em] text-ink uppercase transition-colors duration-300 hover:bg-ink hover:text-ground disabled:cursor-wait disabled:border-hair disabled:text-dim disabled:hover:bg-transparent"
        >
          {planning ? (
            <>
              <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
              Reading your account and the market, about a minute
            </>
          ) : (
            <>
              Plan tonight
              <span className="inline-block transition-transform duration-300 ease-out group-hover:translate-x-1">
                &gt;
              </span>
            </>
          )}
        </button>

        {confirming ? (
          <span className="flex flex-wrap items-center gap-4 font-mono text-[11px] tracking-[0.16em] text-loss uppercase">
            Remove this key and its plans?
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              className="rounded-[8px] border border-loss px-4 py-2 transition-colors duration-200 hover:bg-loss hover:text-ground disabled:cursor-wait"
            >
              {removing ? "Removing" : "Yes, remove"}
            </button>
            <button
              type="button"
              onClick={onAskRemove}
              className="text-dim transition-colors duration-200 hover:text-ink"
            >
              Keep it
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onAskRemove}
            className="self-start font-mono text-[11px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-loss"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-hair py-2 sm:flex-row sm:gap-4">
      <dt className="w-28 shrink-0 tracking-[0.16em] text-dim uppercase">{label}</dt>
      <dd className="min-w-0 break-all text-ink/80">{value}</dd>
    </div>
  );
}
