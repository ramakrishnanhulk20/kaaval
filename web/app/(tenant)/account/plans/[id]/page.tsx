import type { Metadata } from "next";
import { PlanView } from "@/components/tenant/PlanView";
import { SignInGate } from "@/components/tenant/SignInGate";

export const metadata: Metadata = {
  title: "A plan, Kaaval",
  description: "One plan for one connected account: every target, every verdict, every dry-run order.",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PlanPage({ params }: Props) {
  const { id } = await params;

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <div className="max-w-[70rem]">
        <p className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Your own account</p>
        <h1
          className="mt-4 font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(2.2rem, 7vw, 4.6rem)", letterSpacing: "-0.04em", lineHeight: 0.92 }}
        >
          Tonight, as planned
        </h1>
        <div className="mt-5 h-px w-full bg-amber" />

        <div className="mt-12">
          <SignInGate>
            <PlanView planId={id} />
          </SignInGate>
        </div>
      </div>
    </main>
  );
}
