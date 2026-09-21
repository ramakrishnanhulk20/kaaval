import type { Metadata } from "next";
import { PosterButton } from "@/components/PosterButton";
import { PlanBoard } from "@/components/story/PlanBoard";
import { getPlan } from "@/lib/story";

// The plan is the record as it stands this minute, so nothing here is baked into the build.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Demo account, Kaaval",
  description:
    "What a connected trader sees, shown on the record's own paper accounts: tonight's targets, the rulebook's verdict on each, and the orders that would have been sent.",
};

const NOTES = [
  "These are the record's own paper accounts, the ones the brains trade all night. Simulated, and signed.",
  "Every target, verdict and order below came out of the last tick. Nothing on this page is typed in.",
  "Connect your own read-only key and the same board is drawn for your real positions.",
];

export default async function DemoPage() {
  const plan = await getPlan();

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <div className="max-w-[70rem]">
        <p className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
          Demo account / no sign-in, no key
        </p>
        <h1
          className="mt-4 font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(2.4rem, 8vw, 5.4rem)", letterSpacing: "-0.04em", lineHeight: 0.92 }}
        >
          Tonight&apos;s plan
        </h1>
        <div className="mt-5 h-px w-full bg-amber" />

        <p className="mt-8 max-w-[60ch] text-[17px] leading-relaxed text-ink/85 sm:text-[19px]">
          This is what Kaaval shows a trader who has connected an account, drawn for an account
          anyone can check: its own.
        </p>

        <ol className="mt-8 flex flex-col gap-3">
          {NOTES.map((line, index) => (
            <li key={line} className="flex gap-4 font-mono text-[12px] leading-relaxed text-ink/70">
              <span className="text-amber">{String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ol>

        <div className="mt-14">
          {plan === null ? (
            <p className="font-mono text-[12px] tracking-[0.18em] text-dim uppercase">
              no plan written yet, and no decision in the record to rebuild one from
            </p>
          ) : (
            <PlanBoard plan={plan} />
          )}
        </div>

        <div className="mt-14 flex flex-wrap gap-4">
          <PosterButton href="/connect">Watch my own account</PosterButton>
          <PosterButton href="/timeline" tone="quiet">
            Read the whole night
          </PosterButton>
        </div>
      </div>
    </main>
  );
}
