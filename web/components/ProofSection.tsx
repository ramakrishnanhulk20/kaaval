import { ProofPanel } from "@/components/ProofPanel";
import { SectionHead } from "@/components/SectionHead";
import { getStoredProof } from "@/lib/proof";

interface Props {
  /** The home page reads this as a section; /proof reads it as the whole page. */
  index?: string;
  title?: string;
}

export async function ProofSection({ index = "05", title = "TRY TO BREAK IT" }: Props) {
  const run = await getStoredProof();

  return (
    <section id="proof" className="border-t border-hair px-4 py-24 sm:px-8 lg:px-12">
      <SectionHead
        index={index}
        kicker="Proof"
        title={title}
        aside={
          <p className="max-w-[60ch] font-mono text-[11px] leading-[1.9] tracking-[0.12em] text-dim uppercase">
            Every entry is hashed over the one before it and signed with a key that lives outside
            the repo. The ledger check walks the chain, the replay re-runs every recorded fill
            against the order book stored beside it, and the attack script feeds the rulebook
            sixteen hostile orders. The button runs all three again, right now, and prints what
            they say.
          </p>
        }
      />

      <div className="mt-14">
        <ProofPanel initial={run} />
      </div>
    </section>
  );
}
