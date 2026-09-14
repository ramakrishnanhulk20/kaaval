"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Reveal } from "@/components/Reveal";
import { readableSymbol, usdt, utcHourMinute } from "@/lib/format";
import type { RefusalRow } from "@/lib/record";

interface Props {
  rows: RefusalRow[];
  byRule: Array<{ rule: string; count: number }>;
  brains: string[];
}

const GRID =
  "grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 lg:grid-cols-[5.5rem_4rem_5rem_13rem_7rem_minmax(0,1fr)] lg:items-baseline lg:gap-y-0";

export function RefusalTable({ rows, byRule, brains }: Props) {
  const [rule, setRule] = useState<string | null>(null);
  const [brain, setBrain] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      rows.filter(
        (row) => (rule === null || row.rule === rule) && (brain === null || row.brain === brain),
      ),
    [rows, rule, brain],
  );

  return (
    <div>
      <ul className="grid grid-cols-2 gap-px border-y border-hair bg-hair sm:grid-cols-3 lg:grid-cols-4">
        {byRule.map((entry, index) => {
          const on = rule === entry.rule;
          return (
            <Reveal as="li" key={entry.rule} index={index} className="bg-ground">
              <button
                type="button"
                onClick={() => {
                  setRule(on ? null : entry.rule);
                }}
                aria-pressed={on}
                className={`group flex h-full w-full flex-col items-start gap-2 px-4 py-6 text-left transition-colors duration-300 hover:bg-ink/[0.03] ${
                  on ? "bg-ink/[0.04]" : ""
                }`}
              >
                <span
                  className={`font-display text-[2.6rem] leading-none font-extrabold tracking-[-0.04em] transition-colors duration-300 ${
                    on ? "text-amber" : "text-ink group-hover:text-amber"
                  }`}
                >
                  {entry.count}
                </span>
                <span className="w-full font-mono text-[10px] tracking-[0.16em] break-all text-dim uppercase">
                  {entry.rule}
                </span>
              </button>
            </Reveal>
          );
        })}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[10px] tracking-[0.2em] uppercase">
        <span className="text-dim">Brain</span>
        <Filter label="All" on={brain === null} onClick={() => { setBrain(null); }} />
        {brains.map((name) => (
          <Filter
            key={name}
            label={name}
            on={brain === name}
            onClick={() => {
              setBrain(brain === name ? null : name);
            }}
          />
        ))}
        {rule === null ? null : (
          <button
            type="button"
            onClick={() => {
              setRule(null);
            }}
            className="text-amber transition-opacity duration-200 hover:opacity-70"
          >
            clear {rule} x
          </button>
        )}
        <span className="text-dim">
          {shown.length} of {rows.length} shown
        </span>
      </div>

      <div
        aria-hidden
        className={`${GRID} mt-8 hidden border-b border-hair pb-3 font-mono text-[10px] tracking-[0.2em] text-dim uppercase lg:grid`}
      >
        <span>Time</span>
        <span>Entry</span>
        <span>Brain</span>
        <span>Rule</span>
        <span>Asked</span>
        <span>Reason</span>
      </div>

      {shown.length === 0 ? (
        <p className="mt-8 font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
          No refusal matches that filter.
        </p>
      ) : (
        <ul>
          {shown.map((row, index) => (
            <li
              key={row.seq}
              className="group relative border-b border-hair transition-colors duration-300 hover:bg-ink/[0.02]"
            >
              <span
                aria-hidden
                className="absolute top-0 left-0 h-full w-px origin-top scale-y-0 bg-loss transition-transform duration-500 ease-out group-hover:scale-y-100"
              />
              <Row row={row} index={index} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ row, index }: { row: RefusalRow; index: number }) {
  const body = (
    <div className={`${GRID} px-3 py-4 font-mono text-[12px]`}>
      <span className="text-dim lg:text-ink/70">{utcHourMinute(row.ts)}</span>
      <span className="text-dim">{row.seq}</span>
      <span className="col-span-2 text-ink/70 lg:col-span-1">{row.brain}</span>
      <span className="col-span-2 break-all text-loss lg:col-span-1">{row.rule}</span>
      <span className="col-span-2 text-dim lg:col-span-1">
        {row.intent === null
          ? "n/a"
          : `${row.intent.side} ${readableSymbol(row.intent.symbol)}${
              row.intent.notionalUsdt === null ? "" : ` ${usdt(row.intent.notionalUsdt)}`
            }`}
      </span>
      <span className="col-span-2 break-words text-ink/75 lg:col-span-1">
        {row.reason}
        {row.decisionSeq === null ? null : (
          <span className="ml-2 inline-block text-amber opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            decision {row.decisionSeq} &gt;
          </span>
        )}
      </span>
    </div>
  );

  if (row.decisionSeq === null) {
    return <Reveal index={Math.min(index, 8)}>{body}</Reveal>;
  }

  return (
    <Reveal index={Math.min(index, 8)}>
      <Link href={`/decisions/${String(row.decisionSeq)}`} className="block">
        {body}
      </Link>
    </Reveal>
  );
}

function Filter({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`group relative transition-colors duration-200 hover:text-ink ${
        on ? "text-ink" : "text-dim"
      }`}
    >
      {label}
      <span
        className={`absolute inset-x-0 -bottom-1 block h-px origin-left bg-amber transition-transform duration-300 group-hover:scale-x-100 ${
          on ? "scale-x-100" : "scale-x-0"
        }`}
      />
    </button>
  );
}
