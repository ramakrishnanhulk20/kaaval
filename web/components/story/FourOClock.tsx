"use client";

import { useCallback, useRef, type CSSProperties } from "react";
import { PinnedStage, screenVars } from "@/components/story/PinnedStage";
import { dayMonth, price, readableSymbol, utcHourMinute } from "@/lib/format";
import type { FourOClock as Reading } from "@/lib/story";

const SCREENS = 4;

/** The gauge axis runs to a round number above the widest reading, never below 2 percent. */
function scaleFor(rows: Reading["rows"]): number {
  const widest = rows.reduce((most, row) => Math.max(most, Math.abs(row.pct)), 0);
  for (const step of [2, 5, 10, 20, 50]) {
    if (widest <= step) return step;
  }
  return Math.ceil(widest / 10) * 10;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

interface Props {
  reading: Reading;
  /** Bitget's own words about weekend prices, handed over by the server. */
  quote: string;
  quoteSource: string;
}

export function FourOClock({ reading, quote, quoteSource }: Props) {
  const countRef = useRef<HTMLSpanElement | null>(null);
  const cueRef = useRef<HTMLSpanElement | null>(null);
  const most = reading.most;

  const onFrame = useCallback(
    (progress: number, local: number[]) => {
      const cue = cueRef.current;
      if (cue) {
        const index = Math.min(SCREENS - 1, Math.max(0, Math.floor(progress * SCREENS)));
        const text = `0${String(index + 1)} / 0${String(SCREENS)}`;
        if (cue.textContent !== text) cue.textContent = text;
      }
      const count = countRef.current;
      if (count && most) {
        count.textContent = signed(most.pct * (local[SCREENS - 1] ?? 1));
      }
    },
    [most],
  );

  const scale = scaleFor(reading.rows);
  const close = reading.clock.lastRegularClose;

  return (
    <PinnedStage screens={SCREENS} onFrame={onFrame} className="border-t border-hair">
      <ul
        aria-hidden
        className="pointer-events-none absolute top-6 right-4 z-20 flex flex-col gap-2 sm:right-8 lg:right-12"
      >
        {Array.from({ length: SCREENS }, (_, index) => (
          <li
            key={index}
            className="story-cue h-px w-8 bg-ink"
            style={screenVars(index, SCREENS) as CSSProperties}
          />
        ))}
      </ul>

      <p className="pointer-events-none absolute top-5 left-4 z-20 font-mono text-[10px] tracking-[0.3em] text-dim uppercase sm:left-8 lg:left-12">
        Four o&apos;clock in New York
        <span className="text-ink/25"> / </span>
        <span ref={cueRef} className="text-amber">01 / 0{SCREENS}</span>
      </p>

      {/* Screen one: the bell. */}
      <section
        className="story-screen absolute inset-0 flex flex-col justify-center px-4 py-16 sm:px-8 lg:px-12"
        style={screenVars(0, SCREENS) as CSSProperties}
      >
        <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
          <h2
            className="font-display font-extrabold text-ink"
            style={{
              fontSize: "clamp(2.6rem, 8.5vw, 7rem)",
              letterSpacing: "-0.04em",
              lineHeight: 0.92,
            }}
          >
            At 4 p.m.
            <br />
            New York closes.
          </h2>
          <div className="lg:pb-4">
            <p className="font-mono text-[11px] tracking-[0.24em] text-dim uppercase">
              last regular close
            </p>
            <p className="mt-2 font-display text-[clamp(3rem,9vw,6rem)] leading-[0.9] font-extrabold tracking-[-0.04em] text-amber">
              16:00
            </p>
            <p className="mt-2 font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
              ET
              <span className="text-ink/25"> / </span>
              {close === 0 ? "not resolved" : `${dayMonth(close)} ${utcHourMinute(close)} UTC`}
            </p>
          </div>
        </div>
        <div className="mt-10 h-px w-full bg-gradient-to-r from-amber via-hair to-transparent" />
      </section>

      {/* Screen two: the live tape. */}
      <section
        className="story-screen absolute inset-0 flex flex-col justify-center px-4 py-16 sm:px-8 lg:px-12"
        style={screenVars(1, SCREENS) as CSSProperties}
      >
        {reading.headline === null ? (
          <p className="font-mono text-[12px] tracking-[0.2em] text-loss uppercase">
            Bitget tickers unreachable{reading.tickerError === null ? "" : `: ${reading.tickerError}`}
          </p>
        ) : (
          <div className="grid gap-10 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:items-end">
            <h2
              className="font-display font-extrabold text-ink"
              style={{
                fontSize: "clamp(2.6rem, 8.5vw, 7rem)",
                letterSpacing: "-0.04em",
                lineHeight: 0.92,
              }}
            >
              On Bitget,
              <br />
              {readableSymbol(reading.headline.symbol)} keeps trading.
            </h2>
            <div className="border-t border-hair pt-5">
              <p className="flex items-center gap-2 font-mono text-[11px] tracking-[0.22em] text-dim uppercase">
                <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
                {reading.headline.symbol}
                <span className="text-ink/25">/</span>
                last {utcHourMinute(reading.asOf)} UTC
              </p>
              <p className="mt-3 flex flex-wrap items-baseline gap-4">
                <span className="font-display text-[clamp(2.6rem,7vw,4.6rem)] leading-[0.9] font-extrabold tracking-[-0.04em] text-ink tabular-nums">
                  {price(reading.headline.last)}
                </span>
                {reading.headline.changePct === null ? null : (
                  <span
                    className={`font-mono text-[clamp(1rem,2.2vw,1.4rem)] tracking-[0.04em] ${
                      reading.headline.changePct >= 0 ? "text-gain" : "text-loss"
                    }`}
                  >
                    {signed(reading.headline.changePct)}
                  </span>
                )}
              </p>
              <p className="mt-3 max-w-[44ch] text-base leading-relaxed text-ink/70">
                {reading.headlineIsTsla
                  ? "The stock is shut. The token is not."
                  : "rTSLA is not in tonight's universe, so this is the first rToken the rulebook has in force. The stock is shut. The token is not."}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Screen three: Bitget's own words. */}
      <section
        className="story-screen absolute inset-0 flex flex-col justify-center px-4 sm:px-8 lg:px-12"
        style={screenVars(2, SCREENS) as CSSProperties}
      >
        <div className="max-w-[46rem] lg:ml-[8%]">
          <span
            aria-hidden
            className="block font-display text-[clamp(4rem,10vw,8rem)] leading-[0.6] font-extrabold text-amber"
          >
            &ldquo;
          </span>
          <blockquote
            className="mt-2 font-display font-extrabold text-ink"
            style={{
              fontSize: "clamp(1.4rem, 3.2vw, 2.6rem)",
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
            }}
          >
            {quote}
          </blockquote>
          <p className="mt-6 font-mono text-[11px] tracking-[0.26em] text-dim uppercase">
            {quoteSource}
          </p>
        </div>
      </section>

      {/* Screen four: the gauge. */}
      <section
        className="story-screen absolute inset-0 flex flex-col justify-center px-4 py-16 sm:px-8 lg:px-12"
        style={screenVars(3, SCREENS) as CSSProperties}
      >
        {most === null ? (
          <div className="max-w-[40rem]">
            <p className="font-mono text-[11px] tracking-[0.24em] text-dim uppercase">divergence</p>
            <p className="mt-4 font-display text-[clamp(1.8rem,4vw,3rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink">
              {reading.note ?? "not measurable now"}
            </p>
          </div>
        ) : (
          <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
            <div>
              <p className="font-mono text-[11px] tracking-[0.24em] text-dim uppercase">
                furthest from Friday&apos;s close
                <span className="text-ink/25"> / </span>
                anchor {utcHourMinute(most.anchorTs)} UTC
              </p>
              <p className="mt-4 flex flex-wrap items-baseline gap-5">
                <span className="font-display text-[clamp(2.4rem,6vw,4.2rem)] leading-[0.9] font-extrabold tracking-[-0.04em] text-ink">
                  {readableSymbol(most.symbol)}
                </span>
                <span
                  ref={countRef}
                  className={`font-display text-[clamp(3rem,9vw,7rem)] leading-[0.86] font-extrabold tracking-[-0.045em] tabular-nums ${
                    most.pct >= 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  {signed(most.pct)}
                </span>
              </p>

              <div className="relative mt-8 h-16 w-full">
                <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-hair" />
                <div aria-hidden className="absolute top-2 bottom-2 left-1/2 w-px bg-ink/30" />
                <div
                  aria-hidden
                  className="story-gauge-fill absolute top-1/2 h-[3px] bg-amber"
                  style={
                    {
                      width: "50%",
                      left: most.pct >= 0 ? "50%" : undefined,
                      right: most.pct >= 0 ? undefined : "50%",
                      ["--frac" as string]: (Math.abs(most.pct) / scale).toFixed(4),
                      ["--origin" as string]: most.pct >= 0 ? "left" : "right",
                    } as CSSProperties
                  }
                />
                {reading.rows.map((row) => (
                  <span
                    key={row.symbol}
                    title={`${readableSymbol(row.symbol)} ${signed(row.pct)} against ${row.anchorClose.toFixed(2)}`}
                    aria-hidden
                    className="absolute top-1/2 block h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-ink/40"
                    style={{ left: `${String(50 + (row.pct / scale) * 50)}%` }}
                  />
                ))}
                <span className="absolute top-0 left-0 font-mono text-[10px] tracking-[0.16em] text-dim">
                  -{scale}%
                </span>
                <span className="absolute top-0 right-0 font-mono text-[10px] tracking-[0.16em] text-dim">
                  +{scale}%
                </span>
              </div>

              <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-1 border-t border-hair pt-3">
                {reading.rows.map((row) => (
                  <li
                    key={row.symbol}
                    className="group font-mono text-[11px] tracking-[0.06em] text-dim transition-colors duration-200 hover:text-ink"
                    title={`last ${row.last.toFixed(2)} against a close of ${row.anchorClose.toFixed(2)}`}
                  >
                    {readableSymbol(row.symbol)}{" "}
                    <span className={row.pct >= 0 ? "text-gain" : "text-loss"}>
                      {signed(row.pct)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-t border-hair pt-5 lg:pb-2">
              <p className="font-display text-[clamp(1.4rem,2.6vw,2.2rem)] leading-[1.1] font-extrabold tracking-[-0.02em] text-ink">
                This is what re-anchors at the open.
              </p>
              <dl className="mt-5 flex flex-col gap-1 font-mono text-[11px] tracking-[0.06em] text-dim">
                <div className="flex justify-between gap-4 border-t border-hair pt-1.5">
                  <dt>close {dayMonth(most.anchorTs)}</dt>
                  <dd className="text-ink/80 tabular-nums">{price(most.anchorClose)}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-hair pt-1.5">
                  <dt>Bitget now</dt>
                  <dd className="text-ink/80 tabular-nums">{price(most.last)}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-hair pt-1.5">
                  <dt>next open</dt>
                  <dd className="text-ink/80">
                    {reading.clock.nextRegularOpen === 0
                      ? "not resolved"
                      : `${dayMonth(reading.clock.nextRegularOpen)} ${utcHourMinute(reading.clock.nextRegularOpen)} UTC`}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}
      </section>
    </PinnedStage>
  );
}
