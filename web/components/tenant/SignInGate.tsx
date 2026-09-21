"use client";

import { usePrivy } from "@privy-io/react-auth";

/**
 * Nothing on an account screen renders until Privy has answered who this is.
 *
 * The three states are all shown rather than guessed at: still starting up, signed out,
 * and signed in. The token itself is never rendered and never put in a link.
 */
export function SignInGate({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout, user } = usePrivy();

  if (!ready) {
    return (
      <p className="flex items-center gap-3 font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
        <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
        Starting sign-in
      </p>
    );
  }

  if (!authenticated) {
    return (
      <div className="border-y border-hair py-8">
        <p className="max-w-[52ch] text-[15px] leading-relaxed text-ink/70">
          Sign in first, with a code sent to your email. We keep your sign-in and your key, and
          nothing else about you.
        </p>
        <button
          type="button"
          onClick={() => {
            login();
          }}
          className="group mt-6 inline-flex items-center gap-3 rounded-[8px] border border-ink/70 px-5 py-3 font-mono text-[11px] tracking-[0.22em] text-ink uppercase transition-colors duration-300 hover:bg-ink hover:text-ground"
        >
          Sign in
          <span className="inline-block transition-transform duration-300 ease-out group-hover:translate-x-1">
            &gt;
          </span>
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-hair py-4 font-mono text-[11px] tracking-[0.16em] text-dim uppercase">
        <p className="min-w-0 break-all">Signed in as {who(user)}</p>
        <button
          type="button"
          onClick={() => {
            void logout();
          }}
          className="tracking-[0.2em] transition-colors duration-200 hover:text-ink"
        >
          Sign out
        </button>
      </div>
      <div className="mt-10">{children}</div>
    </div>
  );
}

/** The friendliest name Privy has for this trader, and never the DID on its own if better exists. */
function who(user: ReturnType<typeof usePrivy>["user"]): string {
  if (!user) return "this browser";
  return (
    user.email?.address ??
    user.google?.email ??
    (user.twitter?.username === undefined || user.twitter.username === null
      ? undefined
      : `@${user.twitter.username}`) ??
    user.id
  );
}
