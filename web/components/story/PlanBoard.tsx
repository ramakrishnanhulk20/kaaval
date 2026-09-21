import { Reveal } from "@/components/Reveal";
import { readableSymbol, usdt, utcDayTime } from "@/lib/format";
import type { PlanBrain, PlanReading } from "@/lib/story";

function money(value: number | null): string {
  return value === null ? "n/a" : `${usdt(value)} USDT`;
}

function BrainBlock({ brain, index }: { brain: PlanBrain; index: number }) {
  return (
    <Reveal index={index} className="border-t border-hair pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-[11px] tracking-[0.26em] text-amber uppercase">{brain.brain}</p>
        <p className="font-mono text-[10px] tracking-[0.18em] text-dim uppercase">
          {brain.targets.length} {brain.targets.length === 1 ? "target" : "targets"}
          <span className="text-ink/25"> / </span>
          {brain.verdicts.length} {brain.verdicts.length === 1 ? "verdict" : "verdicts"}
          <span className="text-ink/25"> / </span>
          {brain.orders.length} {brain.orders.length === 1 ? "order" : "orders"}
        </p>
      </div>

      {brain.summary === "" ? null : (
        <p className="mt-3 max-w-[68ch] text-[15px] leading-[1.6] text-ink/80">{brain.summary}</p>
      )}

      {brain.targets.length === 0 ? null : (
        <ul className="mt-5 flex flex-col">
          {brain.targets.map((target) => (
            <li
              key={`${target.symbol}-${String(target.notionalUsdt)}`}
              className="grid gap-1 border-t border-hair py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6"
            >
              <p className="font-mono text-[12px] tracking-[0.06em] text-ink">
                {readableSymbol(target.symbol)}
                <span className="text-dim"> {money(target.notionalUsdt)}</span>
              </p>
              <p className="text-[14px] leading-[1.55] text-ink/65">{target.rationale}</p>
            </li>
          ))}
        </ul>
      )}

      {brain.verdicts.length === 0 ? null : (
        <ul className="mt-5 flex flex-col">
          {brain.verdicts.map((verdict, at) => (
            <li
              key={`${verdict.symbol}-${String(at)}`}
              className="grid gap-1 border-t border-hair py-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6"
            >
              <p
                className={`font-mono text-[11px] tracking-[0.16em] uppercase ${
                  verdict.allowed ? "text-gain" : "text-loss"
                }`}
              >
                {verdict.allowed ? "allowed" : "refused"}
              </p>
              <p className="min-w-0 text-[14px] leading-[1.55] text-ink/70">
                <span className="font-mono text-[12px] text-ink">
                  {verdict.side} {readableSymbol(verdict.symbol)} {money(verdict.notionalUsdt)}
                </span>
                {verdict.rule === null ? null : (
                  <span className="font-mono text-[11px] tracking-[0.14em] text-amber">
                    {" "}
                    {verdict.rule}
                  </span>
                )}
                {verdict.reason === null ? null : <span> {verdict.reason}</span>}
              </p>
            </li>
          ))}
        </ul>
      )}

      {brain.orders.length === 0 ? null : (
        <ul className="mt-5 flex flex-col gap-px">
          {brain.orders.map((order, at) => (
            <li
              key={`${order.symbol}-${String(at)}`}
              className="group border-t border-hair py-3 transition-colors duration-300 hover:bg-ink/[0.02]"
            >
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[12px] tracking-[0.06em] text-ink">
                <span className="text-amber uppercase">{order.side}</span>
                {readableSymbol(order.symbol)}
                <span className="text-dim">{money(order.notionalUsdt)}</span>
                {order.qty === null ? null : <span className="text-dim">qty {order.qty}</span>}
                {order.price === null ? null : <span className="text-dim">at {order.price}</span>}
              </p>
              <p className="mt-1 font-mono text-[10px] tracking-[0.16em] text-dim uppercase">
                {order.dryRun ? "dry run" : "recorded fill"}
                {order.path === null ? null : (
                  <>
                    <span className="text-ink/25"> / </span>
                    POST {order.path}
                  </>
                )}
                {order.fill === null ? (
                  order.refusedFill === null ? null : (
                    <>
                      <span className="text-ink/25"> / </span>
                      {order.refusedFill}
                    </>
                  )
                ) : (
                  <>
                    <span className="text-ink/25"> / </span>
                    shadow fill {order.fill.avgPrice.toFixed(4)}
                    {order.fill.feeUsdt === null
                      ? ""
                      : `, fee ${order.fill.feeUsdt.toFixed(4)} USDT`}
                    {order.fill.slippageBps === null
                      ? ""
                      : `, ${order.fill.slippageBps.toFixed(2)} bps`}
                    {order.fill.bookHash === ""
                      ? ""
                      : `, book ${order.fill.bookHash.slice(0, 12)}`}
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}

      {brain.shadowMark === null ? null : (
        <p className="mt-4 border-t border-hair pt-3 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
          {brain.orders.length === 0 ? "nothing to send this tick, the account stands at" : "if every one of those had filled"}
          <span className="text-ink/25"> / </span>
          <span className="text-ink">{money(brain.shadowMark.equityAfter)}</span>
          <span className="text-ink/25"> / </span>
          realised {money(brain.shadowMark.realised)}
          <span className="text-ink/25"> / </span>
          open {money(brain.shadowMark.unrealised)}
        </p>
      )}
    </Reveal>
  );
}

export function PlanBoard({ plan }: { plan: PlanReading }) {
  return (
    <div className="min-w-0">
      <Reveal className="flex flex-wrap items-baseline justify-between gap-3 border-t border-amber pt-4">
        <p className="font-mono text-[11px] tracking-[0.24em] text-ink uppercase">
          {plan.source === "plan-file" ? "plan" : "tonight"}
          <span className="text-ink/25"> / </span>
          {plan.accountId}
        </p>
        <p className="font-mono text-[10px] tracking-[0.18em] text-dim uppercase">
          {utcDayTime(plan.ts)} UTC
          {plan.window === null ? null : (
            <>
              <span className="text-ink/25"> / </span>
              {plan.window} window
            </>
          )}
        </p>
      </Reveal>

      <Reveal delay={0.05}>
        <p className="mt-2 font-mono text-[10px] leading-[1.8] tracking-[0.14em] text-dim uppercase">
          {plan.caption}
          <span className="text-ink/25"> / </span>
          nothing here was sent to Bitget
        </p>
      </Reveal>

      {plan.before === null ? null : (
        <Reveal delay={0.08}>
          <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 font-mono text-[11px] tracking-[0.14em] text-dim uppercase">
            <div>
              <dt className="inline">equity before</dt>{" "}
              <dd className="inline text-ink">{money(plan.before.equity)}</dd>
            </div>
            <div>
              <dt className="inline">cash</dt>{" "}
              <dd className="inline text-ink">{money(plan.before.balanceUsdt)}</dd>
            </div>
            <div>
              <dt className="inline">open positions</dt>{" "}
              <dd className="inline text-ink">{plan.before.positions}</dd>
            </div>
          </dl>
        </Reveal>
      )}

      <div className="mt-8 flex flex-col gap-8">
        {plan.brains.map((brain, index) => (
          <BrainBlock key={brain.brain} brain={brain} index={index} />
        ))}
      </div>
    </div>
  );
}
