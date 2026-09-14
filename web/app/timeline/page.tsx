import type { Metadata } from "next";
import Link from "next/link";
import { NightTimeline } from "@/components/NightTimeline";
import { SectionHead } from "@/components/SectionHead";
import { dayMonth } from "@/lib/format";
import { CADENCE_MINUTES, getDay, getDays } from "@/lib/record";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "The night, Kaaval",
  description:
    "One UTC day of the Kaaval record laid out as time: a lane per brain, every decision, refusal, fill, stop and halt where it happened.",
};

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const asked = typeof params["day"] === "string" ? params["day"] : null;
  const days = await getDays();
  const chosen = asked !== null && days.includes(asked) ? asked : (days.at(-1) ?? null);
  const night = chosen === null ? null : await getDay(chosen);

  return (
    <main className="pt-24">
      <div className="px-4 pb-10 sm:px-8 lg:px-12">
        <SectionHead
          index="02"
          kicker="The night"
          title="ONE DAY, AS IT HAPPENED"
          aside={
            night === null ? undefined : (
              <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <p className="max-w-[52ch] font-mono text-[11px] leading-[1.9] tracking-[0.12em] text-dim uppercase">
                  <span className="text-amber">Simulated</span>. The playhead runs left to right
                  through {night.day} UTC. Every ring, dot, cross and rule below is one signed entry
                  in the ledger, where it happened.
                </p>
                <nav aria-label="Day" className="flex flex-wrap gap-x-5 gap-y-2">
                  {days.map((day) => (
                    <Link
                      key={day}
                      href={`/timeline?day=${day}`}
                      className={`group relative font-mono text-[11px] tracking-[0.2em] uppercase transition-colors duration-200 hover:text-ink ${
                        day === night.day ? "text-ink" : "text-dim"
                      }`}
                    >
                      {dayMonth(Date.parse(`${day}T00:00:00.000Z`))}
                      <span
                        className={`absolute inset-x-0 -bottom-1 block h-px origin-left bg-amber transition-transform duration-300 group-hover:scale-x-100 ${
                          day === night.day ? "scale-x-100" : "scale-x-0"
                        }`}
                      />
                    </Link>
                  ))}
                </nav>
              </div>
            )
          }
        />
      </div>

      {night === null ? (
        <p className="border-t border-hair px-4 py-24 font-mono text-[11px] tracking-[0.2em] text-dim uppercase sm:px-8 lg:px-12">
          The ledger has no day file yet.
        </p>
      ) : (
        <NightTimeline
          night={night}
          startTs={night.startTs}
          endTs={night.endTs}
          cadenceMinutes={CADENCE_MINUTES}
        />
      )}
    </main>
  );
}
