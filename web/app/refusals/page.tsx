import type { Metadata } from "next";
import { RefusalTable } from "@/components/RefusalTable";
import { SectionHead } from "@/components/SectionHead";
import { getRefusals } from "@/lib/record";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Refusals, Kaaval",
  description:
    "Every order the Kaaval rulebook refused, with the rule that refused it and the reason, newest first.",
};

export default async function RefusalsPage() {
  const { rows, byRule, brains } = await getRefusals();

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <SectionHead
        index="03"
        kicker="The refusal log"
        title="WHAT THE RULEBOOK SAID NO TO"
        aside={
          <p className="max-w-[58ch] font-mono text-[11px] leading-[1.9] tracking-[0.12em] text-dim uppercase">
            A brain proposes, the rulebook disposes. Every refusal below was written to the ledger
            at the moment it happened, with the rule that stopped it. Pick a rule or a brain to
            narrow the log.
          </p>
        }
      />

      <div className="mt-14">
        {rows.length === 0 ? (
          <p className="font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
            Nothing has been refused yet.
          </p>
        ) : (
          <RefusalTable rows={rows} byRule={byRule} brains={brains} />
        )}
      </div>
    </main>
  );
}
