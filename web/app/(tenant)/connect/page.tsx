import type { Metadata } from "next";
import { PosterButton } from "@/components/PosterButton";
import { ConnectForm } from "@/components/tenant/ConnectForm";
import { SignInGate } from "@/components/tenant/SignInGate";
import { tenantConfigured } from "@/lib/tenant/env";

export const metadata: Metadata = {
  title: "Connect a key, Kaaval",
  description:
    "Sign in and connect a read-only Bitget key. Kaaval reads the account once and plans against it. No order is ever sent.",
};

const GUIDE = [
  "Create a key on Bitget with read permission only.",
  "We verify it with one read, and show you what it saw.",
  "Our code drops every write before it reaches Bitget.",
];

export default function ConnectPage() {
  const status = tenantConfigured();

  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <div className="max-w-[70rem]">
        <p className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Your own account</p>
        <h1
          className="mt-4 font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(2.4rem, 8vw, 5.4rem)", letterSpacing: "-0.04em", lineHeight: 0.92 }}
        >
          Connect a key
        </h1>
        <div className="mt-5 h-px w-full bg-amber" />

        <p className="mt-8 max-w-[60ch] text-[17px] leading-relaxed text-ink/85 sm:text-[19px]">
          Kaaval reads your Bitget account and tells you what each brain would do with it tonight.
          It plans. It never trades.
        </p>

        <ol className="mt-8 flex flex-col gap-3">
          {GUIDE.map((line, index) => (
            <li key={line} className="flex gap-4 font-mono text-[12px] leading-relaxed text-ink/70">
              <span className="text-amber">{String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ol>

        {status.database && status.sealing ? null : (
          <p className="mt-8 max-w-[60ch] border-l border-amber/60 pl-4 font-mono text-[12px] leading-relaxed text-amber">
            This host cannot store a key yet: {status.missing.join(", ")} still to set. You can sign
            in, but connecting will be refused until that is done.
          </p>
        )}

        <div className="mt-10 flex flex-wrap items-center gap-4 border-l border-hair pl-4">
          <p className="max-w-[44ch] font-mono text-[12px] leading-relaxed text-ink/70">
            No Bitget key to hand? See the same board drawn for the record&apos;s own paper accounts.
          </p>
          <PosterButton href="/demo" tone="quiet">
            Open the demo account
          </PosterButton>
        </div>

        <div className="mt-12">
          <SignInGate>
            <ConnectForm />
          </SignInGate>
        </div>
      </div>
    </main>
  );
}
