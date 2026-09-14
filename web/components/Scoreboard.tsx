import { PosterButton } from "@/components/PosterButton";
import { ScoreTable } from "@/components/ScoreTable";
import { SectionHead } from "@/components/SectionHead";
import { dayMonth, spanWords, usdt, utcHourMinute } from "@/lib/format";
import { CADENCE_MINUTES, getScoreboard } from "@/lib/record";

/** A gap said out loud: when it started, when it ended, how long the record was dark. */
function gapSentence(from: number, to: number, ms: number, trailing: boolean): string {
  const start = `${dayMonth(from)} ${utcHourMinute(from)}`;
  if (trailing) return `no tick since ${start} UTC, ${spanWords(ms)} ago`;
  return `${spanWords(ms)} with no ticks, ${start} to ${dayMonth(to)} ${utcHourMinute(to)} UTC`;
}

export async function Scoreboard() {
  const board = await getScoreboard();
  const gaps = board.gaps.map((gap) =>
    gapSentence(gap.from, gap.to, gap.ms, gap.from === board.lastTickTs),
  );

  const opened =
    board.startedTs === null
      ? "No entries yet"
      : `The record opens ${dayMonth(board.startedTs)} ${utcHourMinute(board.startedTs)} UTC`;

  const note = [
    "Every fill above was matched in our own simulator against the Bitget order book recorded in that tick, and no real money moves.",
    board.startEquity === null
      ? `${opened}.`
      : `${opened}, each brain starting at ${usdt(board.startEquity)} USDT.`,
    gaps.length === 0
      ? `No gap longer than ${String(CADENCE_MINUTES * 2)} minutes.`
      : `${gaps.length === 1 ? "One gap" : `${String(gaps.length)} gaps`} longer than ${String(
          CADENCE_MINUTES * 2,
        )} minutes: ${gaps.join("; ")}.`,
  ].join(" ");

  return (
    <section id="record" className="relative border-t border-hair px-4 py-24 sm:px-8 lg:px-12">
      <SectionHead
        index="01"
        kicker="Scoreboard"
        title="WHO IS AHEAD"
        aside={
          <div className="flex flex-wrap gap-x-8 gap-y-2 font-mono text-[11px] tracking-[0.18em] text-dim uppercase">
            <span>{board.entries} signed entries</span>
            <span>{board.fills} fills</span>
            <span>{board.refusals} refusals</span>
            <span>every tick {CADENCE_MINUTES} minutes</span>
          </div>
        }
      />

      <div className="mt-14">
        {board.rows.length === 0 ? (
          <p className="font-mono text-[12px] tracking-[0.18em] text-dim uppercase">
            No brain has written a mark yet.
          </p>
        ) : (
          <ScoreTable rows={board.rows} startEquity={board.startEquity} />
        )}
      </div>

      <div className="mt-8 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <p className="max-w-[62ch] font-mono text-[11px] leading-[1.9] tracking-[0.12em] text-dim uppercase">
          <span className="text-amber">Simulated</span>. {note}
        </p>

        <div className="flex flex-wrap gap-3">
          <PosterButton href="/timeline">Read the night</PosterButton>
          <PosterButton href="/api/trades.csv" tone="quiet" glyph="&darr;" download>
            Download the trade log
          </PosterButton>
        </div>
      </div>
    </section>
  );
}
