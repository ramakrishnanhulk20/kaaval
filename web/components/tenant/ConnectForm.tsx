"use client";

import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { useState } from "react";
import { connectAction, type ConnectActionResult } from "@/app/(tenant)/actions";

/**
 * The form that turns a read-only Bitget key into a connection.
 *
 * The secret and the passphrase are typed, sent once, and dropped. They are never put
 * back on the screen, never placed in a link, and never kept in this component after the
 * answer comes back, because the only copy that should exist after this is the sealed one
 * in the database.
 */

type State = "idle" | "checking" | "done" | "failed";

const EMPTY = { label: "", apiKey: "", secretKey: "", passphrase: "" };

export function ConnectForm() {
  const { getAccessToken } = usePrivy();
  const [fields, setFields] = useState(EMPTY);
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<ConnectActionResult | null>(null);

  const submit = async (): Promise<void> => {
    setState("checking");
    setResult(null);

    const token = await getAccessToken();
    if (token === null) {
      setResult({ ok: false, reason: "your sign-in has expired. Sign out and in again.", retryable: false });
      setState("failed");
      return;
    }

    try {
      const answer = await connectAction(token, fields);
      setResult(answer);
      setState(answer.ok ? "done" : "failed");
      if (answer.ok) setFields(EMPTY);
      else setFields({ ...fields, secretKey: "", passphrase: "" });
    } catch {
      setResult({
        ok: false,
        reason: "the server could not be reached. Check your connection and try again.",
        retryable: true,
      });
      setState("failed");
    }
  };

  if (state === "done" && result?.ok) {
    return (
      <div className="border-y border-hair py-8">
        <p className="font-mono text-[11px] tracking-[0.2em] text-gain uppercase">Key accepted</p>
        <dl className="mt-5 font-mono text-[12px]">
          <Line label="Account" value={result.uid ?? "not reported by Bitget"} />
          <Line label="Equity" value={`${result.equityUsdt.toFixed(2)} USDT`} />
          <Line label="Positions" value={String(result.positions)} />
        </dl>
        <p className="mt-6 max-w-[52ch] text-[15px] leading-relaxed text-ink/70">
          That was one read. Nothing was placed, changed or cancelled.
        </p>
        <Link
          href="/account"
          className="group mt-6 inline-flex items-center gap-3 rounded-[8px] border border-ink/70 px-5 py-3 font-mono text-[11px] tracking-[0.22em] text-ink uppercase transition-colors duration-300 hover:bg-ink hover:text-ground"
        >
          Go to your account
          <span className="inline-block transition-transform duration-300 ease-out group-hover:translate-x-1">
            &gt;
          </span>
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="border-t border-hair pt-8"
    >
      <div className="flex max-w-[46rem] flex-col gap-6">
        <Field
          label="Label"
          hint="Your name for this key, so you can tell it from the next one."
          value={fields.label}
          onChange={(value) => {
            setFields({ ...fields, label: value });
          }}
          maxLength={40}
        />
        <Field
          label="API key"
          value={fields.apiKey}
          onChange={(value) => {
            setFields({ ...fields, apiKey: value });
          }}
          maxLength={128}
        />
        <Field
          label="Secret key"
          secret
          value={fields.secretKey}
          onChange={(value) => {
            setFields({ ...fields, secretKey: value });
          }}
          maxLength={128}
        />
        <Field
          label="Passphrase"
          secret
          value={fields.passphrase}
          onChange={(value) => {
            setFields({ ...fields, passphrase: value });
          }}
          maxLength={128}
        />
      </div>

      <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={state === "checking"}
          className="group inline-flex items-center gap-3 rounded-[8px] border border-ink/70 px-5 py-3 font-mono text-[11px] tracking-[0.22em] text-ink uppercase transition-colors duration-300 hover:bg-ink hover:text-ground disabled:cursor-wait disabled:border-hair disabled:text-dim disabled:hover:bg-transparent"
        >
          {state === "checking" ? (
            <>
              <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
              Checking your key with one read
            </>
          ) : (
            <>
              Connect this key
              <span className="inline-block transition-transform duration-300 ease-out group-hover:translate-x-1">
                &gt;
              </span>
            </>
          )}
        </button>
      </div>

      {state === "failed" && result && !result.ok ? (
        <div className="mt-8 border-l border-loss pl-4">
          <p className="font-mono text-[10px] tracking-[0.2em] text-loss uppercase">That key was not stored</p>
          <p className="mt-2 max-w-[60ch] font-mono text-[12px] leading-relaxed text-ink/80">{result.reason}</p>
          <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-ink/60">{nextStep(result)}</p>
        </div>
      ) : null}
    </form>
  );
}

/** What to do about this failure, in one sentence, chosen from what Bitget said. */
function nextStep(result: { reason: string; retryable: boolean }): string {
  const reason = result.reason.toLowerCase();
  if (reason.includes("passphrase") || reason.includes("secret")) {
    return "Bitget shows the passphrase once, when the key is made. If it is not to hand, make a new key and paste all three values again.";
  }
  if (reason.includes("ip allow list") || reason.includes("permissions")) {
    return "Open the key on Bitget, and either add this server to its IP allow list or take the allow list off. Read permission is all we need.";
  }
  if (reason.includes("rate limiting")) {
    return "Bitget is throttling this key. Give it a minute, then try again.";
  }
  if (result.retryable) {
    return "Nothing is wrong with the key itself. Try again in a minute.";
  }
  return "Check all three values were copied whole, with no spaces at either end.";
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  secret?: boolean;
  maxLength: number;
}

function Field({ label, value, onChange, hint, secret = false, maxLength }: FieldProps) {
  return (
    <label className="flex flex-col gap-2">
      <span className="font-mono text-[10px] tracking-[0.2em] text-dim uppercase">{label}</span>
      {hint === undefined ? null : <span className="text-[13px] leading-relaxed text-ink/50">{hint}</span>}
      <input
        type={secret ? "password" : "text"}
        value={value}
        maxLength={maxLength}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded-[8px] border border-hair bg-ink/[0.03] px-4 py-3 font-mono text-[13px] text-ink outline-none transition-colors duration-200 focus:border-amber/60"
      />
    </label>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-hair py-2 sm:flex-row sm:gap-4">
      <dt className="w-28 shrink-0 tracking-[0.16em] text-dim uppercase">{label}</dt>
      <dd className="min-w-0 break-all text-ink/80">{value}</dd>
    </div>
  );
}
