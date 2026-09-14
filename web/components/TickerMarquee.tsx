"use client";

import { useEffect, useState } from "react";
import type { TickerBoard, TickerRow } from "@/lib/bitget";
import { price, signedPct, utcTime } from "@/lib/format";

const REFRESH_MS = 30_000;

export function TickerMarquee({ initial }: { initial: TickerBoard }) {
  const [board, setBoard] = useState<TickerBoard>(initial);

  useEffect(() => {
    let alive = true;
    const pull = async (): Promise<void> => {
      try {
        const response = await fetch("/api/ticker", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as TickerBoard;
        if (alive) setBoard(next);
      } catch {
        // A refresh that fails leaves the last real prices on screen with their own stamp.
      }
    };
    const timer = setInterval(() => void pull(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const empty = board.rows.length === 0;

  return (
    <div className="fixed inset-x-0 top-11 z-40 h-9 border-b border-hair bg-ground/85 backdrop-blur-sm">
      <div className="marquee relative flex h-full items-center overflow-hidden">
        {empty ? (
          <span className="px-4 font-mono text-[11px] uppercase tracking-[0.2em] text-loss sm:px-6">
            Bitget tickers unreachable
          </span>
        ) : (
          <div className="marquee-track flex w-max shrink-0 items-center">
            <Run rows={board.rows} />
            <Run rows={board.rows} muted />
          </div>
        )}

        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center">
          <span aria-hidden className="h-full w-16 bg-gradient-to-r from-transparent to-ground" />
          <span className="flex h-full items-center border-l border-hair bg-ground px-4 font-mono text-[10px] uppercase tracking-[0.2em] text-dim sm:px-6">
            <span className="hidden sm:inline">as of&nbsp;</span>
            {utcTime(board.asOf)} UTC
          </span>
        </div>
      </div>
    </div>
  );
}

function Run({ rows, muted = false }: { rows: TickerRow[]; muted?: boolean }) {
  return (
    <div aria-hidden={muted} className="flex items-center">
      {rows.map((row) => (
        <TickerCard key={`${muted ? "b" : "a"}-${row.symbol}`} row={row} />
      ))}
    </div>
  );
}

export function TickerCard({ row }: { row: TickerRow }) {
  const up = (row.changePct ?? 0) >= 0;
  return (
    <div className="flex items-baseline gap-3 border-l border-hair px-5 font-mono text-[11px] leading-none tracking-[0.08em] whitespace-nowrap">
      <span className="text-ink">{row.name}</span>
      <span className="text-dim">{price(row.last)}</span>
      <span className={row.changePct === null ? "text-dim" : up ? "text-gain" : "text-loss"}>
        {row.changePct === null ? "n/a" : signedPct(row.changePct)}
      </span>
    </div>
  );
}
