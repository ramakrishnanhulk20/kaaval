"use client";

import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { planDetailAction, type PlanDetailResult } from "@/app/(tenant)/actions";
import { readableSymbol, usdt, utcDayTime } from "@/lib/format";
import type { StoredPlan } from "@/lib/tenant/plans";

/**
 * One stored plan, read the way the public record's decision pages are read.
 *
 * Every panel is the plan as it was signed. Nothing is recomputed in the browser, because
 * a page that recalculated a number would be showing something the signature does not
 * cover.
 */

type GetToken = () => Promise<string | null>;

/** One read of one plan, with no state of its own. */
async function readPlan(getAccessToken: GetToken, planId: string): Promise<PlanDetailResult> {
  const token = await getAccessToken();
  if (token === null) return { ok: false, reason: "your sign-in has expired. Sign out and in again." };
  return await planDetailAction(token, planId);
}

export function PlanView({ planId }: { planId: string }) {
  const { getAccessToken } = usePrivy();
  const [result, setResult] = useState<PlanDetailResult | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setResult(await readPlan(getAccessToken, planId));
  }, [getAccessToken, planId]);

  // The plan is read with a token that only exists in this browser, so the answer arrives
  // in a callback and is dropped if the trader has already moved on.
  useEffect(() => {
    let alive = true;
    void readPlan(getAccessToken, planId).then((answer) => {
      if (alive) setResult(answer);
    });
    return () => {
      alive = false;
    };
  }, [getAccessToken, planId]);

  if (result === null) {
    return (
      <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
        <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
        Reading the plan
      </p>
    );
  }

  if (!result.ok) {
    return (
      <div className="border-l border-loss pl-4">
        <p className="font-mono text-[10px] tracking-[0.2em] text-loss uppercase">This did not load</p>
        <p className="mt-2 max-w-[60ch] font-mono text-[12px] leading-relaxed text-ink/80">{result.reason}</p>
        <button
          type="button"
          onClick={() => {
            setResult(null);
            void load();
          }}
          className="mt-4 font-mono text-[11px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  if (result.plan === null) {
    return (
      <div className="border-l border-amber/60 pl-4">
        <p className="font-mono text-[12px] leading-relaxed text-ink/80">
          There is no plan with that address on your account. It may have been removed with the key
          it belonged to.
        </p>
        <Link
          href="/account"
          className="mt-4 inline-block font-mono text-[11px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-ink"
        >
          Back to your account
        </Link>
      </div>
    );
  }

  return <Stored stored={result.plan} />;
}

function Stored({ stored }: { stored: StoredPlan }) {
  const plan = stored.plan;

  return (
    <div>
      <p className="border border-hair px-4 py-3 font-mono text-[12px] leading-relaxed text-amber">
        Nothing was sent to Bitget. Every order below is a dry run on a read-only key.
      </p>

      <dl className="mt-8 font-mono text-[11px]">
        <Line label="Made" value={`${utcDayTime(plan.ts)} UTC`} />
        <Line label="Window" value={plan.window} />
        <Line label="Key" value={stored.label} />
        <Line label="Account" value={plan.accountId} />
        <Line label="Universe" value={plan.universe.map(readableSymbol).join(", ") || "empty"} />
        <Line label="Rulebook" value={plan.rulebookHash} />
      </dl>

      <h2 className="mt-16 font-mono text-[11px] tracking-[0.3em] text-dim uppercase">The account before</h2>
      <dl className="mt-4 font-mono text-[12px]">
        <Line label="Equity" value={`${usdt(plan.before.equity)} USDT`} />
        <Line label="Free cash" value={`${usdt(plan.before.balanceUsdt)} USDT`} />
        <Line label="Open profit" value={`${usdt(plan.before.unrealised)} USDT`} />
      </dl>

      {plan.before.positions.length === 0 ? (
        <p className="mt-4 font-mono text-[12px] text-dim">No positions.</p>
      ) : (
        <ul className="mt-4">
          {plan.before.positions.map((position) => (
            <li
              key={`${position.category}:${position.symbol}`}
              className="flex flex-col gap-1 border-b border-hair py-3 font-mono text-[12px] sm:flex-row sm:gap-6"
            >
              <span className="w-40 shrink-0 text-ink">{readableSymbol(position.symbol)}</span>
              <span className="w-24 shrink-0 text-dim">{position.side}</span>
              <span className="w-32 shrink-0 text-dim">{position.qty}</span>
              <span className="min-w-0 text-dim">
                marked {position.mark.toFixed(4)}, worth {usdt(position.notionalUsdt)} USDT
              </span>
            </li>
          ))}
        </ul>
      )}

      {plan.brains.map((brain) => (
        <section key={brain.brain} className="mt-20">
          <h2
            className="font-display font-extrabold text-ink"
            style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)", letterSpacing: "-0.03em" }}
          >
            {brain.brain.toUpperCase()}
          </h2>
          <div className="mt-3 h-px w-full bg-hair" />

          {brain.error === null ? null : (
            <p className="mt-4 border-l border-loss pl-4 font-mono text-[12px] text-loss">
              No decision: {brain.error}
            </p>
          )}

          {brain.decision === null ? null : (
            <>
              <p className="mt-6 max-w-[64ch] text-[16px] leading-relaxed text-ink/80">
                {brain.decision.summary}
              </p>
              {brain.decision.targets.length === 0 ? (
                <p className="mt-4 font-mono text-[12px] text-dim">It wants nothing tonight.</p>
              ) : (
                <ul className="mt-6">
                  {brain.decision.targets.map((target) => (
                    <li key={`${target.category}:${target.symbol}`} className="border-t border-hair py-5">
                      <p className="font-mono text-[12px] text-ink">
                        {readableSymbol(target.symbol)}
                        <span className="text-ink/25"> / </span>
                        <span className="text-dim">
                          target {usdt(target.targetNotionalUsdt)} USDT, confidence{" "}
                          {target.confidence.toFixed(2)}, {String(target.horizonMinutes)} minute horizon
                        </span>
                      </p>
                      <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-ink/65">
                        {target.rationale}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <h3 className="mt-10 font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
            What the rulebook said
          </h3>
          {brain.verdicts.length === 0 ? (
            <p className="mt-4 font-mono text-[12px] text-dim">Nothing to judge.</p>
          ) : (
            <ul className="mt-4">
              {brain.verdicts.map((verdict, index) => (
                <li
                  key={`${verdict.intent.symbol}-${String(index)}`}
                  className={`border-l py-3 pl-4 ${verdict.allowed ? "border-gain/50" : "border-loss/60"}`}
                >
                  <p
                    className={`font-mono text-[10px] tracking-[0.2em] uppercase ${
                      verdict.allowed ? "text-gain" : "text-loss"
                    }`}
                  >
                    {verdict.allowed ? "Allowed" : `Refused by ${verdict.rule}`}
                  </p>
                  <p className="mt-1 font-mono text-[12px] break-words text-ink/75">
                    {verdict.intent.side} {readableSymbol(verdict.intent.symbol)},{" "}
                    {usdt(verdict.intent.notionalUsdt)} USDT
                    {verdict.intent.reduceOnly ? ", reduce only" : ""}
                  </p>
                  {verdict.allowed ? null : (
                    <p className="mt-1 max-w-[70ch] font-mono text-[11px] text-dim">{verdict.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 className="mt-10 font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
            The orders it would have sent
          </h3>
          {brain.orders.length === 0 ? (
            <p className="mt-4 font-mono text-[12px] text-dim">None.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-8">
              {brain.orders.map((order, index) => (
                <li key={`${order.intent.symbol}-${String(index)}`} className="border-t border-hair pt-5">
                  <p className="font-mono text-[12px] text-ink">
                    {order.intent.side} {readableSymbol(order.intent.symbol)}
                    <span className="text-ink/25"> / </span>
                    <span className="text-dim">
                      {usdt(order.intent.notionalUsdt)} USDT, {order.intent.category}
                    </span>
                  </p>

                  <p className="mt-4 font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
                    The Agent Hub request
                  </p>
                  <pre className="mt-2 overflow-x-auto border border-hair p-4 font-mono text-[11px] leading-relaxed text-ink/70">
                    {JSON.stringify(order.dryRun, null, 2)}
                  </pre>

                  <p className="mt-4 font-mono text-[11px] text-dim">{fillLine(order.shadowFill)}</p>
                  {order.bookHash === null ? null : (
                    <p className="mt-1 font-mono text-[11px] break-all text-ink/40">book {order.bookHash}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-8 max-w-[70ch] font-mono text-[12px] leading-relaxed text-ink/70">
            If every one of those had filled, the part of this account Kaaval trades would be worth{" "}
            {usdt(brain.shadowMark.equityAfter)} USDT: {usdt(brain.shadowMark.realised)} realised,{" "}
            {usdt(brain.shadowMark.unrealised)} open.
          </p>
        </section>
      ))}

      <section className="mt-20 border-t border-hair pt-8">
        <h2 className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">The signature</h2>
        {stored.signature === null ? (
          <p className="mt-4 max-w-[64ch] font-mono text-[12px] leading-relaxed text-amber">
            This plan is not signed: the host that made it has no plan signing key set. The plan is
            still exactly what was computed, but nobody can prove later that it was not edited.
          </p>
        ) : (
          <>
            <dl className="mt-4 font-mono text-[11px]">
              <Line label="Signature" value={stored.signature} />
              <Line label="Public key" value={stored.publicKeyHex ?? "not published on this host"} />
            </dl>
            <p className="mt-4 max-w-[70ch] text-[14px] leading-relaxed text-ink/60">
              The signature is Ed25519 over the canonical JSON of the plan above, the same shape the
              public record is signed in. Verify it with node: read the plan, sort its keys, and
              check the signature against the public key.
            </p>
          </>
        )}
      </section>

      <Link
        href="/account"
        className="mt-12 inline-block font-mono text-[11px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-ink"
      >
        &lt; Back to your account
      </Link>
    </div>
  );
}

function fillLine(fill: StoredPlan["plan"]["brains"][number]["orders"][number]["shadowFill"]): string {
  if (fill === null) return "No book to fill against in this pass.";
  if ("rejected" in fill) return `Shadow fill refused: ${fill.reason}`;
  return `Shadow fill ${String(fill.qty)} at ${fill.avgPrice.toFixed(4)}, fee ${fill.feeUsdt.toFixed(4)} USDT, slippage ${fill.slippageBps.toFixed(2)} bps.`;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-hair py-2 sm:flex-row sm:gap-4">
      <dt className="w-28 shrink-0 tracking-[0.16em] text-dim uppercase">{label}</dt>
      <dd className="min-w-0 break-all text-ink/80">{value}</dd>
    </div>
  );
}
