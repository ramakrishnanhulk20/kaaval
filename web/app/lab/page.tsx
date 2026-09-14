import type { Metadata } from "next";
import { EquityCurves } from "@/components/EquityCurves";
import { PosterButton } from "@/components/PosterButton";
import { FourOClock } from "@/components/story/FourOClock";
import { PlanBoard } from "@/components/story/PlanBoard";
import { SisterLine } from "@/components/story/SisterLine";
import { Watch } from "@/components/story/Watch";
import { TickerCard } from "@/components/TickerMarquee";
import { getTickerBoard } from "@/lib/bitget";
import { heroSentence } from "@/lib/copy";
import { CADENCE_MINUTES, getCurves, getState } from "@/lib/record";
import {
  BITGET_WEEKEND_SOURCE,
  BITGET_WEEKEND_WORDS,
  getFourOClock,
  getPlan,
  getWatch,
  vidiyalUrl,
} from "@/lib/story";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kaaval lab",
  robots: { index: false, follow: false },
};

export default async function LabPage() {
  const curves = await getCurves();
  const state = await getState();
  const board = await getTickerBoard();
  const row = board.rows[0] ?? null;
  const brains = state.brains.length;
  const four = await getFourOClock();
  const watch = await getWatch();
  const plan = await getPlan();

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-dim">
        lab &middot; taste check, not a page
      </p>

      <div className="relative mt-8 h-[60svh] w-full border-t border-hair">
        <EquityCurves
          className="absolute inset-0"
          curves={curves}
          startEquity={state.balanceUsdt}
          cadenceMinutes={CADENCE_MINUTES}
          bandBottom={0.84}
        />
      </div>

      <div className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          display &middot; bricolage grotesque 800
        </p>
        <p
          className="mt-4 font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(4rem, 14vw, 12rem)", letterSpacing: "-0.04em", lineHeight: 0.9 }}
        >
          KAAVAL
        </p>
      </div>

      <div className="mt-20 grid gap-12 border-t border-hair pt-8 lg:grid-cols-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
            label &middot; ibm plex mono
          </p>
          <p className="mt-4 font-mono text-[11px] tracking-[0.26em] text-ink">
            SIMULATED RECORD &middot; {brains} {brains === 1 ? "BRAIN" : "BRAINS"}, 1 RULEBOOK
            &middot; BITGET rTOKENS
          </p>
          <p className="mt-3 flex flex-wrap gap-x-6 font-mono text-[11px] tracking-[0.06em] text-dim">
            {curves.map((curve) => {
              const last = curve.points.at(-1);
              const change =
                last && state.balanceUsdt
                  ? ((last.equity - state.balanceUsdt) / state.balanceUsdt) * 100
                  : null;
              return (
                <span key={curve.brain}>
                  {last ? last.equity.toFixed(2) : "no mark"}{" "}
                  {change === null ? null : (
                    <span className={change >= 0 ? "text-gain" : "text-loss"}>
                      {change >= 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </span>
                  )}
                </span>
              );
            })}
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
            body &middot; ibm plex sans
          </p>
          <p className="mt-4 max-w-[38rem] text-base leading-relaxed text-ink/70">
            {heroSentence(brains)}
          </p>
        </div>
      </div>

      <div className="mt-20 flex flex-wrap items-center gap-3 border-t border-hair pt-8">
        <PosterButton href="#record">Read the record</PosterButton>
        <PosterButton href="#proof" tone="quiet">
          Verify it
        </PosterButton>
      </div>

      <div className="mt-20 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">ticker card</p>
        <div className="mt-4 flex">
          {row === null ? (
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-loss">
              Bitget tickers unreachable
            </span>
          ) : (
            <TickerCard row={row} />
          )}
        </div>
      </div>

      <div className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 01 &middot; the hero lines
        </p>
        <p className="mt-5 max-w-[34ch] font-display text-[clamp(1.4rem,3.2vw,2.4rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink">
          Your rTokens do not sleep. Neither does Kaaval.
        </p>
        <p className="mt-4 max-w-[38rem] text-base leading-relaxed text-ink/70">
          The night watch for tokenized US stocks on Bitget. {brains}{" "}
          {brains === 1 ? "brain" : "brains"}, one rulebook, every decision signed.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <PosterButton href="/connect">Watch my account</PosterButton>
          <PosterButton href="#record" tone="quiet">
            Read the record
          </PosterButton>
        </div>
      </div>

      <div className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 02 &middot; four o&apos;clock in New York, pinned
        </p>
      </div>
      <FourOClock reading={four} quote={BITGET_WEEKEND_WORDS} quoteSource={BITGET_WEEKEND_SOURCE} />

      <div className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 03 &middot; what the watch does, pinned
        </p>
      </div>
      <Watch reading={watch} />

      <div id="record" className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 04 &middot; the scoreboard, as built, with its line
        </p>
        <p className="mt-5 max-w-[26ch] font-display text-[clamp(1.4rem,3vw,2.4rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink">
          The baseline cannot think. If the models do not beat it, the record says so.
        </p>
      </div>

      <div className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 05 &middot; tonight&apos;s plan
        </p>
        <div className="mt-8">
          {plan === null ? (
            <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-dim">
              no plan written yet, and no decision in the record to rebuild one from
            </p>
          ) : (
            <PlanBoard plan={plan} />
          )}
        </div>
      </div>

      <div id="proof" className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 06 &middot; the proof strip, as built
        </p>
      </div>

      <div className="mt-24 border-t border-hair pt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-dim">
          beat 07 &middot; the sister line
        </p>
      </div>
      <SisterLine href={vidiyalUrl()} />
    </main>
  );
}
