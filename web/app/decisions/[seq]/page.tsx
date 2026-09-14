import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Reveal } from "@/components/Reveal";
import { duration, readableSymbol, usdt, utcTime } from "@/lib/format";
import { getDecision, type FillRow, type OrderRow, type RefusalRow } from "@/lib/record";

export const revalidate = 60;

interface Props {
  params: Promise<{ seq: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { seq } = await params;
  return {
    title: `Decision ${seq}, Kaaval`,
    description: "One decision from the Kaaval ledger, with every target, verdict, order and fill.",
  };
}

export default async function DecisionPage({ params }: Props) {
  const { seq } = await params;
  const detail = await getDecision(Number(seq));
  if (!detail) notFound();

  const { decision, verdicts } = detail;
  const day = new Date(decision.ts).toISOString().slice(0, 10);
  const loose = detail.refusals.filter(
    (refusal) => !decision.targets.some((target) => target.symbol === refusal.intent?.symbol),
  );

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <div className="grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16">
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <p className="font-mono text-[11px] tracking-[0.3em] text-amber">
            {String(decision.seq).padStart(3, "0")}
          </p>
          <dl className="mt-5 border-t border-hair font-mono text-[11px]">
            <Meta label="Brain" value={decision.brain} />
            <Meta label="Written" value={`${utcTime(decision.ts)} UTC`} />
            <Meta label="Day" value={day} />
            <Meta
              label="Model calls"
              value={decision.modelCalls === null ? "n/a" : String(decision.modelCalls)}
            />
            <Meta
              label="Tokens"
              value={
                decision.promptTokens === null && decision.completionTokens === null
                  ? "n/a"
                  : `${String(decision.promptTokens ?? 0)} in, ${String(decision.completionTokens ?? 0)} out`
              }
            />
            <Meta
              label="Latency"
              value={decision.latencyMs === null ? "n/a" : duration(decision.latencyMs)}
            />
            <Meta label="Targets" value={String(decision.targets.length)} />
            <Meta label="Refusals" value={String(detail.refusals.length)} />
            <Meta label="Fills" value={String(detail.fills.length)} />
          </dl>

          <nav className="mt-6 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
            {detail.previousSeq === null ? null : (
              <Link
                href={`/decisions/${String(detail.previousSeq)}`}
                className="transition-colors duration-200 hover:text-ink"
              >
                &lt; earlier
              </Link>
            )}
            {detail.nextSeq === null ? null : (
              <Link
                href={`/decisions/${String(detail.nextSeq)}`}
                className="transition-colors duration-200 hover:text-ink"
              >
                later &gt;
              </Link>
            )}
            <Link
              href={`/timeline?day=${day}`}
              className="transition-colors duration-200 hover:text-ink"
            >
              this night
            </Link>
          </nav>
        </aside>

        <div className="min-w-0">
          <Reveal>
            <p className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
              The record as written
            </p>
            <h1
              className="mt-4 font-display font-extrabold text-ink"
              style={{
                fontSize: "clamp(2.6rem, 8vw, 6rem)",
                letterSpacing: "-0.04em",
                lineHeight: 0.9,
              }}
            >
              {decision.brain.toUpperCase()}
              <span className="text-dim"> {utcTime(decision.ts).slice(0, 5)}</span>
            </h1>
            <div className="mt-5 h-px w-full bg-amber" />
          </Reveal>

          {decision.error === null ? null : (
            <Reveal index={1} className="mt-8 border border-loss/40 p-5">
              <p className="font-mono text-[10px] tracking-[0.2em] text-loss uppercase">
                This decision failed
              </p>
              <p className="mt-2 font-mono text-[12px] break-words text-ink/80">{decision.error}</p>
            </Reveal>
          )}

          <Reveal index={1}>
            <p className="mt-8 max-w-[64ch] text-[17px] leading-relaxed text-ink/85 sm:text-[19px]">
              {decision.summary}
            </p>
          </Reveal>

          <Reveal index={2}>
            <h2 className="mt-16 font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
              Targets and what the rulebook did with them
            </h2>
          </Reveal>

          {verdicts.length === 0 ? (
            <p className="mt-6 font-mono text-[12px] text-dim">
              No targets. The brain asked for nothing this tick.
            </p>
          ) : (
            <ul className="mt-6">
              {verdicts.map((verdict, index) => (
                <Reveal as="li" key={verdict.target.symbol} index={index} className="border-t border-hair py-8">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                    <h3
                      className="font-display font-extrabold text-ink"
                      style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)", letterSpacing: "-0.03em" }}
                    >
                      {readableSymbol(verdict.target.symbol)}
                    </h3>
                    <p className="font-mono text-[11px] tracking-[0.14em] text-dim">
                      {verdict.target.targetNotionalUsdt === null
                        ? "no size"
                        : `${usdt(verdict.target.targetNotionalUsdt)} USDT`}
                      <span className="text-ink/25"> / </span>
                      {verdict.target.confidence === null
                        ? "no confidence"
                        : `confidence ${verdict.target.confidence.toFixed(2)}`}
                      <span className="text-ink/25"> / </span>
                      {verdict.target.horizonMinutes === null
                        ? "no horizon"
                        : `${String(verdict.target.horizonMinutes)} minute horizon`}
                      {verdict.target.hedgeFor === null ? null : (
                        <>
                          <span className="text-ink/25"> / </span>
                          hedge for {readableSymbol(verdict.target.hedgeFor)}
                        </>
                      )}
                    </p>
                  </div>

                  {verdict.target.rationale === "" ? null : (
                    <p className="mt-4 max-w-[70ch] text-[15px] leading-relaxed text-ink/70">
                      {verdict.target.rationale}
                    </p>
                  )}

                  <div className="mt-5 flex flex-col gap-3">
                    {verdict.refusals.map((refusal) => (
                      <Refusal key={refusal.seq} refusal={refusal} />
                    ))}
                    {verdict.orders.map((order) => (
                      <Order key={order.seq} order={order} fill={verdict.fills.find((item) => item.orderId === order.orderId) ?? null} />
                    ))}
                    {verdict.refusals.length === 0 && verdict.orders.length === 0 ? (
                      <p className="font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
                        No order and no refusal followed: the book already held this target.
                      </p>
                    ) : null}
                  </div>
                </Reveal>
              ))}
            </ul>
          )}

          {loose.length === 0 ? null : (
            <Reveal className="mt-16">
              <h2 className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
                Refused before the brain spoke
              </h2>
              <p className="mt-3 max-w-[64ch] text-[14px] leading-relaxed text-ink/60">
                Risk cutting runs first, so these refusals sit in this window without belonging to
                any target above.
              </p>
              <div className="mt-5 flex flex-col gap-3">
                {loose.map((refusal) => (
                  <Refusal key={refusal.seq} refusal={refusal} />
                ))}
              </div>
            </Reveal>
          )}
        </div>
      </div>
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 border-b border-hair py-2">
      <dt className="w-24 shrink-0 tracking-[0.16em] text-dim uppercase">{label}</dt>
      <dd className="min-w-0 break-words text-ink/80">{value}</dd>
    </div>
  );
}

function Refusal({ refusal }: { refusal: RefusalRow }) {
  return (
    <div className="border-l border-loss/60 pl-4">
      <p className="font-mono text-[10px] tracking-[0.2em] text-loss uppercase">
        Refused
        <span className="text-ink/25"> / </span>
        {refusal.rule}
        <span className="text-ink/25"> / </span>
        entry {refusal.seq}
      </p>
      <p className="mt-1 font-mono text-[12px] text-ink/75">{refusal.reason}</p>
      {refusal.intent === null ? null : (
        <p className="mt-1 font-mono text-[11px] text-dim">
          asked: {refusal.intent.side} {readableSymbol(refusal.intent.symbol)}
          {refusal.intent.notionalUsdt === null
            ? ""
            : `, ${usdt(refusal.intent.notionalUsdt)} USDT`}
          {refusal.intent.reduceOnly ? ", reduce only" : ""}
          {refusal.intent.source === "" ? "" : `, from ${refusal.intent.source}`}
        </p>
      )}
    </div>
  );
}

function Order({ order, fill }: { order: OrderRow; fill: FillRow | null }) {
  return (
    <div className="border-l border-gain/50 pl-4">
      <p className="font-mono text-[10px] tracking-[0.2em] text-gain uppercase">
        Allowed
        <span className="text-ink/25"> / </span>
        {order.side} {order.type}
        <span className="text-ink/25"> / </span>
        entry {order.seq}
      </p>
      <p className="mt-1 font-mono text-[12px] text-ink/75">
        {order.qty === null ? "no size" : `${String(order.qty)} ${readableSymbol(order.symbol)}`}
        {order.limitPrice === null ? "" : ` at ${String(order.limitPrice)}`}
        {order.reduceOnly ? ", reduce only" : ""}
        {order.source === "" ? "" : `, from ${order.source}`}
      </p>
      {order.notes.length === 0 ? null : (
        <ul className="mt-1 font-mono text-[11px] text-amber">
          {order.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {fill === null ? (
        <p className="mt-1 font-mono text-[11px] text-dim">No fill followed this order.</p>
      ) : (
        <p className="mt-1 font-mono text-[11px] text-dim">
          filled {fill.qty === null ? "n/a" : String(fill.qty)} at{" "}
          {fill.avgPrice === null ? "n/a" : fill.avgPrice.toFixed(4)}, fee{" "}
          {fill.feeUsdt === null ? "n/a" : fill.feeUsdt.toFixed(4)} USDT, slippage{" "}
          {fill.slippageBps === null ? "n/a" : fill.slippageBps.toFixed(2)} bps, book{" "}
          <span className="break-all text-ink/60">{fill.bookHash}</span>
          {fill.demo ? ", filled on the Bitget demo environment" : ", filled in the simulator"}
        </p>
      )}

      <Block label="Agent Hub dry run request" value={order.agentHubRequest} />
      <Block label="Stop request" value={order.stopRequest} />
    </div>
  );
}

function Block({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <details className="group mt-3">
      <summary className="cursor-pointer font-mono text-[10px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-ink">
        {label}
        <span className="ml-2 inline-block transition-transform duration-200 group-open:rotate-90">
          &gt;
        </span>
      </summary>
      <pre className="mt-2 overflow-x-auto border border-hair p-4 font-mono text-[11px] leading-relaxed text-ink/70">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
