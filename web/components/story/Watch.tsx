"use client";

import Link from "next/link";
import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { PinnedStage, screenVars } from "@/components/story/PinnedStage";
import { duration, readableSymbol, usdt, utcHourMinute, utcTime } from "@/lib/format";
import type { WatchReading } from "@/lib/story";

const SCREENS = 4;

const VERBS = ["SEES", "DECIDES", "REFUSES", "SIGNS"];

function Screen({
  index,
  verb,
  line,
  children,
}: {
  index: number;
  verb: string;
  line: string;
  children: ReactNode;
}) {
  return (
    <section
      className="story-screen absolute inset-0 flex flex-col justify-center px-4 py-14 sm:px-8 lg:px-12"
      style={screenVars(index, SCREENS) as CSSProperties}
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-end">
        <div>
          <p className="font-mono text-[11px] tracking-[0.3em] text-amber">
            0{index + 1} / 0{SCREENS}
          </p>
          <h3
            className="mt-3 font-display font-extrabold text-ink"
            style={{
              fontSize: "clamp(2.8rem, 9vw, 6.5rem)",
              letterSpacing: "-0.045em",
              lineHeight: 0.88,
            }}
          >
            {verb}
          </h3>
          <p className="mt-4 max-w-[30ch] text-base leading-relaxed text-ink/70">{line}</p>
        </div>
        <div className="min-w-0 border-t border-hair pt-6">{children}</div>
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-hair py-1.5">
      <dt className="font-mono text-[10px] tracking-[0.2em] text-dim uppercase">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[12px] tracking-[0.04em] text-ink/85">{value}</dd>
    </div>
  );
}

export function Watch({ reading }: { reading: WatchReading }) {
  const cueRef = useRef<HTMLSpanElement | null>(null);

  const onFrame = useCallback((progress: number) => {
    const cue = cueRef.current;
    if (!cue) return;
    const index = Math.min(SCREENS - 1, Math.max(0, Math.floor(progress * SCREENS)));
    const text = VERBS[index] ?? "";
    if (cue.textContent !== text) cue.textContent = text;
  }, []);

  const { sees, decides, refuses, signs } = reading;
  const symbols = [...sees.symbols, ...sees.hedges];

  return (
    <PinnedStage screens={SCREENS} onFrame={onFrame} className="border-t border-hair">
      <p className="pointer-events-none absolute top-5 left-4 z-20 font-mono text-[10px] tracking-[0.3em] text-dim uppercase sm:left-8 lg:left-12">
        What the watch does
        <span className="text-ink/25"> / </span>
        <span ref={cueRef} className="text-amber">{VERBS[0]}</span>
      </p>

      <ul
        aria-hidden
        className="pointer-events-none absolute top-6 right-4 z-20 flex flex-col gap-2 sm:right-8 lg:right-12"
      >
        {VERBS.map((verb, index) => (
          <li
            key={verb}
            className="story-cue h-px w-8 bg-ink"
            style={screenVars(index, SCREENS) as CSSProperties}
          />
        ))}
      </ul>

      <Screen
        index={0}
        verb="SEES"
        line="One world, built once a tick and handed to every brain unchanged, so a difference between them can only come from the brain."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[10px] tracking-[0.22em] text-dim uppercase">
              {symbols.length} instruments in force
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-x-4">
              {symbols.map((symbol) => (
                <li
                  key={symbol}
                  className="border-t border-hair py-1 font-mono text-[12px] tracking-[0.06em] text-ink/85"
                >
                  {readableSymbol(symbol)}
                </li>
              ))}
            </ul>
          </div>
          <dl className="flex flex-col">
            {sees.book === null ? (
              <Field label="book" value="no book stored yet" />
            ) : (
              <>
                <Field
                  label={`book ${readableSymbol(sees.book.symbol)}`}
                  value={`${sees.book.bid.toFixed(2)} / ${sees.book.ask.toFixed(2)}`}
                />
                <Field label="spread" value={`${sees.book.spreadBps.toFixed(2)} bps`} />
                <Field label="depth" value={`${sees.book.levels} levels a side`} />
                <Field label="book hash" value={sees.book.bookHash.slice(0, 16)} />
              </>
            )}
            <Field
              label="news"
              value={
                sees.news === null
                  ? "not published with the record"
                  : `${sees.news.items} headlines, ${utcHourMinute(sees.news.gatheredTs)} UTC`
              }
            />
            <Field label="new york" value={sees.clock.nowEt} />
            <Field
              label="session"
              value={sees.clock.regularSessionOpen ? "open" : "shut until 09:30 ET"}
            />
          </dl>
        </div>
      </Screen>

      <Screen
        index={1}
        verb="DECIDES"
        line="A brain proposes targets, never orders, and writes down why in its own words."
      >
        {decides === null ? (
          <p className="font-mono text-[12px] tracking-[0.18em] text-dim uppercase">
            no decision in the record yet
          </p>
        ) : (
          <div>
            <p className="font-mono text-[10px] tracking-[0.22em] text-dim uppercase">
              <span className="text-amber">{decides.brain}</span>
              <span className="text-ink/25"> / </span>
              seq {decides.seq}
              <span className="text-ink/25"> / </span>
              {utcTime(decides.ts)} UTC
              <span className="text-ink/25"> / </span>
              {decides.targets} {decides.targets === 1 ? "target" : "targets"}
            </p>
            <p className="mt-4 max-w-[62ch] text-[15px] leading-[1.6] text-ink/85">
              {decides.summary}
            </p>
            <p className="mt-5 max-w-[62ch] border-l border-amber pl-4 text-[14px] leading-[1.6] text-ink/70">
              <span className="font-mono text-[11px] tracking-[0.16em] text-amber">
                {readableSymbol(decides.symbol)}
              </span>{" "}
              {decides.rationale}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
                confidence {decides.confidence === null ? "n/a" : decides.confidence.toFixed(2)}
              </span>
              <span className="font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
                {decides.modelCalls === null ? "no" : decides.modelCalls} model{" "}
                {decides.modelCalls === 1 ? "call" : "calls"}
              </span>
              <span className="font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
                {decides.latencyMs === null ? "n/a" : duration(decides.latencyMs)} to answer
              </span>
              <Link
                href={`/decisions/${String(decides.seq)}`}
                className="group font-mono text-[10px] tracking-[0.2em] text-ink uppercase"
              >
                read the whole decision
                <span className="ml-2 inline-block transition-transform duration-300 group-hover:translate-x-1">
                  &gt;
                </span>
              </Link>
            </div>
          </div>
        )}
      </Screen>

      <Screen
        index={2}
        verb="REFUSES"
        line="The rulebook runs in code after the brain has spoken. It cannot be argued with, and every refusal is written down."
      >
        {refuses === null ? (
          <p className="font-mono text-[12px] tracking-[0.18em] text-dim uppercase">
            no refusal in the record yet
          </p>
        ) : (
          <div>
            <p className="font-mono text-[10px] tracking-[0.22em] text-dim uppercase">
              <span className="text-amber">{refuses.brain}</span>
              <span className="text-ink/25"> / </span>
              seq {refuses.seq}
              <span className="text-ink/25"> / </span>
              {utcTime(refuses.ts)} UTC
            </p>
            <p
              className="mt-3 font-display font-extrabold text-loss"
              style={{
                fontSize: "clamp(1.6rem, 3.4vw, 2.6rem)",
                letterSpacing: "-0.03em",
                lineHeight: 1,
              }}
            >
              {refuses.rule}
            </p>
            <p className="mt-4 max-w-[60ch] text-[15px] leading-[1.6] text-ink/85">
              {refuses.reason}
            </p>
            <dl className="mt-5 grid gap-x-8 sm:grid-cols-3">
              <Field label="symbol" value={readableSymbol(refuses.symbol ?? "")} />
              <Field label="side" value={refuses.side ?? "n/a"} />
              <Field
                label="size asked"
                value={refuses.notionalUsdt === null ? "n/a" : `${usdt(refuses.notionalUsdt)} USDT`}
              />
            </dl>
            <Link
              href="/refusals"
              className="group mt-5 inline-block font-mono text-[10px] tracking-[0.2em] text-ink uppercase"
            >
              every refusal ever written
              <span className="ml-2 inline-block transition-transform duration-300 group-hover:translate-x-1">
                &gt;
              </span>
            </Link>
          </div>
        )}
      </Screen>

      <Screen
        index={3}
        verb="SIGNS"
        line="Each entry carries the hash of the one before it and a signature over both. Change one line and the chain breaks at that line."
      >
        <div>
          <ol className="flex flex-col">
            {signs.links.map((link, index) => (
              <li key={link.seq}>
                {index === 0 ? null : (
                  <span
                    aria-hidden
                    className="story-chain-link mx-3 block h-6 w-px bg-amber sm:mx-5"
                  />
                )}
                <div className="group grid gap-2 border border-hair px-4 py-3 transition-colors duration-300 hover:border-ink/40 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-6">
                  <p className="font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
                    <span className="text-ink">seq {link.seq}</span>
                    <span className="text-ink/25"> / </span>
                    {link.kind}
                    <span className="text-ink/25"> / </span>
                    {link.account}
                  </p>
                  <p className="min-w-0 font-mono text-[11px] tracking-[0.04em] break-all text-dim">
                    <span className="text-amber">hash</span> {(link.hash ?? "none").slice(0, 24)}
                    <span className="text-ink/25"> &middot; </span>
                    <span className="text-amber">prev</span> {(link.prevHash ?? "none").slice(0, 16)}
                    <span className="text-ink/25"> &middot; </span>
                    {link.signed ? "signed" : "unsigned"}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-6 font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
            public key
            <span className="text-ink/25"> / </span>
            {signs.keySource}
            <span className="text-ink/25"> / </span>
            {signs.entries} entries in the chain
          </p>
          <p className="mt-2 font-mono text-[11px] tracking-[0.04em] break-all text-ink/70">
            {signs.publicKeyHex ?? "no key published yet"}
          </p>
        </div>
      </Screen>
    </PinnedStage>
  );
}
