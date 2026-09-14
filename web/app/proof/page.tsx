import type { Metadata } from "next";
import { ProofSection } from "@/components/ProofSection";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Proof, Kaaval",
  description:
    "The ledger check, the replay and the attack script, with their output as last run and a button that runs all three again.",
};

export default function ProofPage() {
  return (
    <main className="pt-16">
      <ProofSection />
    </main>
  );
}
