"use client";

import { useState } from "react";
import { Reveal } from "@/components/Reveal";
import { attackTable, checkLines, type ProofCheck, type ProofRun } from "@/lib/proof-format";

interface Props {
  initial: ProofRun | null;
}

type State = "idle" | "running" | "failed";

export function ProofPanel({ initial }: Props) {
  const [run, setRun] = useState<ProofRun | null>(initial);
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  const attack = async (): Promise<void> => {
    setState("running");
    setError(null);
    try {
      const response = await fetch("/api/proof", { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : `The proof run answered ${String(response.status)}.`;
        setError(message);
        setState("failed");
        return;
      }
      setRun(body as ProofRun);
      setState("idle");
    } catch {
      setError(
        "The proof run could not be reached. The site has to be served from the machine that holds the ledger.",
      );
      setState("failed");
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-6 border-y border-hair py-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="font-mono text-[11px] tracking-[0.16em] text-dim uppercase">
          {run === null ? (
            <p>No proof run has been stored yet. Run npm run proof:web beside the engine.</p>
          ) : (
            <>
              <p>
                <span className={run.allPassed ? "text-gain" : "text-loss"}>
                  {run.allPassed ? "All three checks passed" : "A check failed"}
                </span>
                <span className="text-ink/25"> / </span>
                {run.entries === null ? "entries unknown" : `${String(run.entries)} signed entries`}
                <span className="text-ink/25"> / </span>
                {run.stored ? "last stored run" : "run just now"}
                {run.generatedAt === null ? "" : ` ${run.generatedAt.replace("T", " ").slice(0, 19)} UTC`}
              </p>
              {run.publicKeyHex === null ? null : (
                <p className="mt-2 break-all text-ink/40">
                  public key <span className="normal-case">{run.publicKeyHex}</span>
                </p>
              )}
              {run.note === null ? null : <p className="mt-2 text-amber">{run.note}</p>}
            </>
          )}
        </div>

        <div className="flex flex-col items-start gap-2 lg:items-end">
          <button
            type="button"
            onClick={() => {
              void attack();
            }}
            disabled={state === "running"}
            className="group inline-flex items-center gap-3 rounded-[8px] border border-ink/70 px-5 py-3 font-mono text-[11px] tracking-[0.22em] text-ink uppercase transition-colors duration-300 hover:bg-ink hover:text-ground disabled:cursor-wait disabled:border-hair disabled:text-dim disabled:hover:bg-transparent"
          >
            {state === "running" ? (
              <>
                <span aria-hidden className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
                Running the three checks
              </>
            ) : (
              <>
                Try to break it
                <span className="inline-block transition-transform duration-300 ease-out group-hover:translate-x-1">
                  &gt;
                </span>
              </>
            )}
          </button>
          <p className="max-w-[34ch] font-mono text-[10px] leading-[1.8] tracking-[0.14em] text-dim uppercase lg:text-right">
            {state === "running"
              ? "Re-checking every hash, replaying every fill, feeding sixteen hostile orders to the rulebook."
              : "The ledger check, the replay and the attack script, run again on the machine that holds the record."}
          </p>
        </div>
      </div>

      {error === null ? null : (
        <p className="mt-6 border-l border-loss pl-4 font-mono text-[11px] leading-relaxed text-loss">
          {error}
        </p>
      )}

      {run === null ? null : (
        <div className="mt-10 flex flex-col gap-12">
          {run.checks.map((check, index) => (
            <Reveal key={check.name} index={index}>
              <Check check={check} stamp={run.generatedAt} />
            </Reveal>
          ))}
        </div>
      )}
    </div>
  );
}

function Check({ check, stamp }: { check: ProofCheck; stamp: string | null }) {
  const table = attackTable(check.output);

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-hair pb-3">
        <h3 className="font-mono text-[13px] tracking-[0.2em] text-ink uppercase">
          <span className={check.ok ? "text-gain" : "text-loss"}>{check.ok ? "PASS" : "FAIL"}</span>{" "}
          {check.name}
        </h3>
        <p className="font-mono text-[10px] tracking-[0.14em] text-dim">
          {check.command}
          <span className="text-ink/25"> / </span>
          exit {check.exitCode}
          {stamp === null ? null : (
            <>
              <span className="text-ink/25"> / </span>
              run at {stamp.replace("T", " ").slice(0, 19)} UTC
            </>
          )}
        </p>
      </div>

      {table === null ? (
        <dl className="mt-4 font-mono text-[12px]">
          {checkLines(check.output).map(([label, value]) => (
            <div key={`${label}${value}`} className="flex flex-col gap-1 border-b border-hair py-2 sm:flex-row sm:gap-4">
              <dt className="w-32 shrink-0 tracking-[0.16em] text-dim uppercase">{label}</dt>
              <dd className="min-w-0 break-all text-ink/80">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <AttackRows table={table} />
      )}
    </section>
  );
}

function AttackRows({ table }: { table: NonNullable<ReturnType<typeof attackTable>> }) {
  return (
    <div>
      {table.intro.length > 0 ? (
        <p className="mt-4 max-w-[64ch] text-[14px] leading-relaxed text-ink/60">
          {table.intro.join(" ")}
        </p>
      ) : null}

      <div
        aria-hidden
        className="mt-6 hidden grid-cols-[11rem_minmax(0,1fr)_5rem_5rem_11rem] gap-4 border-b border-hair pb-2 font-mono text-[10px] tracking-[0.18em] text-dim uppercase lg:grid"
      >
        {table.headers.map((header) => (
          <span key={header}>{header}</span>
        ))}
      </div>

      <ul>
        {table.rows.map((row) => {
          const expected = row[2] ?? "";
          const outcome = row[3] ?? "";
          const held = expected === outcome;
          return (
            <li
              key={row[0]}
              className="grid grid-cols-1 gap-x-4 gap-y-1 border-b border-hair py-4 font-mono text-[12px] lg:grid-cols-[11rem_minmax(0,1fr)_5rem_5rem_11rem] lg:items-baseline"
            >
              <span className="text-ink">{row[0]}</span>
              <span className="text-dim">{row[1]}</span>
              <span className="text-dim lg:text-right">
                <span className="lg:hidden">expected </span>
                {expected}
              </span>
              <span className={`${held ? "text-gain" : "text-loss"} lg:text-right`}>
                <span className="text-dim lg:hidden">outcome </span>
                {outcome}
              </span>
              <span className="break-all text-ink/50 lg:text-right">{row[4]}</span>
            </li>
          );
        })}
      </ul>

      {table.summary.map((line, index) => (
        <p
          key={line}
          className={`mt-4 font-mono text-[12px] leading-relaxed ${
            index === 0 ? "text-ink" : "text-amber"
          }`}
        >
          {line}
        </p>
      ))}
    </div>
  );
}
