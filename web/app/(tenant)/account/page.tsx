import type { Metadata } from "next";
import Link from "next/link";
import { AccountArea } from "@/components/tenant/AccountArea";
import { SignInGate } from "@/components/tenant/SignInGate";

export const metadata: Metadata = {
  title: "Your account, Kaaval",
  description: "The Bitget keys you have connected, and every plan Kaaval has made for them.",
};

// Planning a night reads the account, reads the market and asks the models, so the request
// needs the long end of the host's limit rather than the ten seconds a page gets.
export const maxDuration = 300;

export default function AccountPage() {
  return (
    <main className="px-4 pt-28 pb-32 sm:px-8 lg:px-12">
      <div className="max-w-[70rem]">
        <p className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Your own account</p>
        <h1
          className="mt-4 font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(2.4rem, 8vw, 5.4rem)", letterSpacing: "-0.04em", lineHeight: 0.92 }}
        >
          Your account
        </h1>
        <div className="mt-5 h-px w-full bg-amber" />

        <p className="mt-8 max-w-[60ch] text-[17px] leading-relaxed text-ink/85 sm:text-[19px]">
          Ask for tonight and Kaaval reads your balances, reads the market, and writes what every
          brain would do under the rulebook.{" "}
          <Link href="/connect" className="text-ink underline decoration-amber underline-offset-4">
            Connect another key
          </Link>{" "}
          whenever you want.
        </p>

        <div className="mt-12">
          <SignInGate>
            <AccountArea />
          </SignInGate>
        </div>
      </div>
    </main>
  );
}
