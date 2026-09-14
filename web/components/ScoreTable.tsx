"use client";

import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import { Signed } from "@/components/Signed";
import { Sparkline } from "@/components/Sparkline";
import { readableSymbol, usdt, utcHourMinute } from "@/lib/format";
import type { ScoreRow } from "@/lib/record";

const COLUMNS = [
  "Equity",
  "Day",
  "Total",
  "Realised",
  "Unrealised",
  "Drawdown",
  "Open",
  "Fills",
  "Refusals",
];

const GRID =
  "grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-[12rem_repeat(9,minmax(0,1fr))_7rem] lg:gap-y-0";

interface Props {
  rows: ScoreRow[];
  startEquity: number | null;
}

export function ScoreTable({ rows, startEquity }: Props) {
  return (
    <div>
      <div
        aria-hidden
        className={`${GRID} hidden border-b border-hair pb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-dim lg:grid`}
      >
        <span>Brain</span>
        {COLUMNS.map((column) => (
          <span key={column} className="text-right">
            {column}
          </span>
        ))}
        <span className="text-right">Curve</span>
      </div>

      <ul>
        {rows.map((row, index) => (
          <Reveal
            as="li"
            key={row.brain}
            index={index}
            className="group relative border-b border-hair py-6 transition-colors duration-300 hover:bg-ink/[0.02] lg:py-4"
          >
            <span
              aria-hidden
              className="absolute top-0 left-0 h-full w-px origin-top scale-y-0 bg-amber transition-transform duration-500 ease-out group-hover:scale-y-100"
            />

            <div className={`${GRID} px-3 font-mono text-[12px] lg:items-baseline`}>
              <div className="col-span-2 flex items-baseline gap-3 sm:col-span-3 lg:col-span-1">
                <span className="text-[11px] tracking-[0.2em] text-amber">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-[15px] tracking-[0.1em] text-ink lg:text-[13px]">
                  {row.brain}
                </span>
                {row.baseline ? (
                  <span className="border border-hair px-1.5 py-0.5 text-[9px] tracking-[0.18em] text-dim uppercase">
                    Baseline
                  </span>
                ) : null}
                {row.halted ? (
                  <span className="border border-loss/50 px-1.5 py-0.5 text-[9px] tracking-[0.18em] text-loss uppercase">
                    Halted
                  </span>
                ) : null}
              </div>

              <Cell label="Equity">
                <span className="text-ink tabular-nums">
                  {row.equity === null ? "no mark" : usdt(row.equity)}
                </span>
              </Cell>
              <Cell label="Day">
                <Signed value={row.dayPnlPct} className="tabular-nums" />
              </Cell>
              <Cell label="Total">
                <Signed value={row.totalReturnPct} className="tabular-nums" />
              </Cell>
              <Cell label="Realised">
                <Signed value={row.realised} kind="usdt" className="tabular-nums" />
              </Cell>
              <Cell label="Unrealised">
                <Signed value={row.unrealised} kind="usdt" className="tabular-nums" />
              </Cell>
              <Cell label="Drawdown">
                <Signed value={row.drawdownPct} alwaysLoss className="tabular-nums" />
              </Cell>
              <Cell label="Open">
                <span className="text-ink/80 tabular-nums">{row.positions.length}</span>
              </Cell>
              <Cell label="Fills">
                <span className="text-ink/80 tabular-nums">{row.fills}</span>
              </Cell>
              <Cell label="Refusals">
                <span className={`tabular-nums ${row.refusals > 0 ? "text-loss/80" : "text-dim"}`}>
                  {row.refusals}
                </span>
              </Cell>

              <div className="col-span-2 flex items-center sm:col-span-3 lg:col-span-1 lg:justify-end">
                <Sparkline points={row.curve} start={startEquity} />
              </div>
            </div>

            <div className="mt-4 px-3 lg:mt-3">
              {row.positions.length > 0 ? (
                <p className="font-mono text-[10px] tracking-[0.14em] text-dim uppercase">
                  Holding{" "}
                  {row.positions
                    .map((position) => `${position.side} ${readableSymbol(position.symbol)}`)
                    .join(", ")}
                </p>
              ) : (
                <p className="font-mono text-[10px] tracking-[0.14em] text-dim uppercase">Flat</p>
              )}

              {row.lastDecision === null ? (
                <p className="mt-2 text-[13px] text-dim">No decision written yet.</p>
              ) : (
                <Link
                  href={`/decisions/${String(row.lastDecision.seq)}`}
                  className="group/link mt-2 block max-w-[68ch] text-[13px] leading-relaxed text-ink/60 transition-colors duration-200 hover:text-ink"
                >
                  <span className="font-mono text-[10px] tracking-[0.18em] text-dim uppercase">
                    {utcHourMinute(row.lastDecision.ts)} UTC
                    <span className="text-ink/25"> / </span>
                    entry {row.lastDecision.seq}
                  </span>{" "}
                  {row.lastDecision.error === null ? (
                    row.lastDecision.summary
                  ) : (
                    <span className="text-loss">{row.lastDecision.summary}</span>
                  )}
                  <span className="ml-1 inline-block text-amber opacity-0 transition-opacity duration-200 group-hover/link:opacity-100">
                    &gt;
                  </span>
                </Link>
              )}
            </div>
          </Reveal>
        ))}
      </ul>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 lg:block lg:text-right">
      <span className="font-mono text-[9px] tracking-[0.2em] text-dim uppercase lg:hidden">
        {label}
      </span>
      {children}
    </div>
  );
}
