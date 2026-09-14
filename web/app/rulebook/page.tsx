import type { Metadata } from "next";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { readableSymbol, utcDayTime } from "@/lib/format";
import { getRulebookHistory } from "@/lib/record";
import { rulebookBlocks } from "@/lib/rulebook";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "The rulebook, Kaaval",
  description:
    "The limits every Kaaval brain trades under, exactly as they were written to the signed ledger.",
};

export default async function RulebookPage() {
  const { current, versions, repeats } = await getRulebookHistory();

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <SectionHead
        index="04"
        kicker="The rulebook"
        title="THE LIMITS IN FORCE"
        aside={
          current === null ? undefined : (
            <p className="max-w-[62ch] font-mono text-[11px] leading-[1.9] tracking-[0.12em] text-dim uppercase">
              This is the text the brains were handed, read back out of the ledger. Written at{" "}
              {utcDayTime(current.ts)} UTC as entry {current.seq}
              {repeats === 0
                ? "."
                : `, and carried unchanged by ${String(repeats)} later config ${
                    repeats === 1 ? "entry" : "entries"
                  }.`}{" "}
              The limits are enforced in code after a brain decides, not asked of it.
            </p>
          )
        }
      />

      {current === null ? (
        <p className="mt-14 font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
          No config entry carries a rulebook yet.
        </p>
      ) : (
        <>
          <div className="mt-16">
            {rulebookBlocks(current.text).map((block, index) => (
              <Reveal
                key={block.label ?? `block-${String(index)}`}
                index={Math.min(index, 6)}
                className="grid gap-4 border-t border-hair py-8 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12"
              >
                <h2 className="font-mono text-[11px] tracking-[0.24em] text-amber uppercase lg:sticky lg:top-28 lg:self-start">
                  {block.label ?? "In force"}
                </h2>
                <div className="min-w-0">
                  {block.paragraphs.map((paragraph) => (
                    <p
                      key={paragraph.slice(0, 40)}
                      className="max-w-[70ch] text-[16px] leading-relaxed text-ink/80 not-first:mt-4 sm:text-[17px]"
                    >
                      {paragraph}
                    </p>
                  ))}
                  {block.bullets.length === 0 ? null : (
                    <ul
                      className={`max-w-[70ch] ${block.paragraphs.length > 0 ? "mt-4" : ""} flex flex-col gap-3`}
                    >
                      {block.bullets.map((bullet) => (
                        <li
                          key={bullet.slice(0, 40)}
                          className="border-l border-hair pl-4 text-[15px] leading-relaxed text-ink/70 transition-colors duration-300 hover:border-amber hover:text-ink/90 sm:text-[16px]"
                        >
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-20 border-t border-hair pt-10">
            <h2 className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">
              Every config entry that changed it
            </h2>
            <ul className="mt-6">
              {versions.map((version, index) => (
                <Reveal
                  as="li"
                  key={version.seq}
                  index={index}
                  className="grid gap-2 border-b border-hair py-5 font-mono text-[11px] lg:grid-cols-[6rem_11rem_minmax(0,1fr)] lg:gap-8"
                >
                  <span className="tracking-[0.2em] text-amber">
                    entry {String(version.seq).padStart(3, "0")}
                  </span>
                  <span className="text-ink/70">{utcDayTime(version.ts)} UTC</span>
                  <span className="min-w-0 text-dim">
                    {version.note ?? "no note"}
                    {version.brains.length === 0
                      ? null
                      : ` / brains ${version.brains.join(", ")}`}
                    {version.universe.length === 0
                      ? null
                      : ` / universe ${version.universe.map(readableSymbol).join(", ")}`}
                    {version.publicKeyHex === null ? null : (
                      <span className="block break-all text-ink/40">
                        signing key {version.publicKeyHex}
                      </span>
                    )}
                  </span>
                </Reveal>
              ))}
            </ul>
          </Reveal>
        </>
      )}
    </main>
  );
}
