import { Hero, type LegendEntry } from "@/components/Hero";
import { PosterButton } from "@/components/PosterButton";
import { ProofSection } from "@/components/ProofSection";
import { Reveal } from "@/components/Reveal";
import { Scoreboard } from "@/components/Scoreboard";
import { FourOClock } from "@/components/story/FourOClock";
import { PlanBoard } from "@/components/story/PlanBoard";
import { SisterLine } from "@/components/story/SisterLine";
import { Watch } from "@/components/story/Watch";
import { dayMonth, posterDate, utcHourMinute } from "@/lib/format";
import {
  CADENCE_MINUTES,
  getCurves,
  getFirstEntryTs,
  getState,
  recordPaused,
} from "@/lib/record";
import {
  BITGET_WEEKEND_SOURCE,
  BITGET_WEEKEND_WORDS,
  getFourOClock,
  getPlan,
  getWatch,
  vidiyalUrl,
} from "@/lib/story";

// The record moves once a tick, so a minute old page is never a minute wrong.
export const revalidate = 60;

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

export default async function Page() {
  const [curves, state, firstEntryTs, four, watch, plan] = await Promise.all([
    getCurves(),
    getState(),
    getFirstEntryTs(),
    getFourOClock(),
    getWatch(),
    getPlan(),
  ]);

  const brainCount = state.brains.length;
  // Written in the case it is shown in: rTOKENS keeps its small r, which a CSS uppercase
  // would eat.
  const metadata = [
    "SIMULATED RECORD",
    `${String(brainCount)} ${brainCount === 1 ? "BRAIN" : "BRAINS"}, 1 RULEBOOK`,
    "BITGET rTOKENS",
    firstEntryTs === null ? "NO ENTRIES YET" : `SINCE ${posterDate(firstEntryTs)}`,
    "24/7",
  ];

  // The count of brains comes from the record, so this line can never contradict the row
  // above it.
  const word = COUNT_WORDS[brainCount] ?? String(brainCount);
  const body = `The night watch for tokenized US stocks on Bitget. ${word} ${
    brainCount === 1 ? "brain" : "brains"
  }, one rulebook, every decision signed.`;

  const legend: LegendEntry[] = state.brains.map((brain) => {
    const points = curves.find((curve) => curve.brain === brain)?.points ?? [];
    const last = points.at(-1) ?? null;
    const start = state.balanceUsdt;
    return {
      brain,
      marks: points.length,
      equity: last?.equity ?? null,
      changePct:
        last && start !== null && start > 0 ? ((last.equity - start) / start) * 100 : null,
    };
  });

  const lastTickLabel =
    state.lastTickTs > 0
      ? `${utcHourMinute(state.lastTickTs)} UTC, ${dayMonth(state.lastTickTs)}`
      : null;

  return (
    <main>
      <Hero
        curves={curves}
        legend={legend}
        startEquity={state.balanceUsdt}
        cadenceMinutes={CADENCE_MINUTES}
        metadata={metadata}
        body={body}
        tagline="Your rTokens do not sleep. Neither does Kaaval."
        actions={[
          { label: "Watch my account", href: "/connect" },
          { label: "Read the record", href: "#record", tone: "quiet" },
        ]}
        lastTickLabel={lastTickLabel}
        paused={recordPaused(state.lastTickTs)}
      />

      <FourOClock reading={four} quote={BITGET_WEEKEND_WORDS} quoteSource={BITGET_WEEKEND_SOURCE} />

      <Watch reading={watch} />

      <div className="border-t border-hair px-4 pt-20 sm:px-8 lg:px-12">
        <Reveal>
          <p className="max-w-[26ch] font-display text-[clamp(1.6rem,3.4vw,2.8rem)] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink">
            The baseline cannot think. If the models do not beat it, the record says so.
          </p>
        </Reveal>
      </div>

      <Scoreboard />

      <section className="border-t border-hair px-4 py-24 sm:px-8 lg:px-12">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <Reveal>
              <p className="font-mono text-[11px] tracking-[0.3em] text-amber uppercase">
                Try before you trust
              </p>
              <h2
                className="mt-4 font-display font-extrabold text-ink"
                style={{
                  fontSize: "clamp(2.2rem, 6vw, 4.4rem)",
                  letterSpacing: "-0.04em",
                  lineHeight: 0.94,
                }}
              >
                Paste a read-only key.
              </h2>
            </Reveal>
            <Reveal delay={0.08}>
              <p className="mt-6 max-w-[46ch] text-base leading-relaxed text-ink/70">
                Tonight Kaaval watches your account and shows you every order it would have
                sent, with the rule that allowed or refused each one. It cannot place one; our
                code drops every write before it reaches Bitget.
              </p>
            </Reveal>
            <Reveal delay={0.14}>
              <div className="mt-8 flex flex-wrap gap-4">
                <PosterButton href="/connect">Watch my account</PosterButton>
                <PosterButton href="/demo" tone="quiet">
                  See the demo account
                </PosterButton>
              </div>
            </Reveal>
          </div>

          {plan === null ? (
            <Reveal>
              <p className="font-mono text-[12px] tracking-[0.18em] text-dim uppercase">
                no plan written yet, and no decision in the record to rebuild one from
              </p>
            </Reveal>
          ) : (
            <PlanBoard plan={plan} />
          )}
        </div>
      </section>

      <ProofSection />

      <SisterLine href={vidiyalUrl()} />
    </main>
  );
}
