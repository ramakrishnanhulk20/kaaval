import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Runs the three proofs and stores what they printed, so the site can show the last run
 * on a host that has no engine and no ledger beside it. The stored file is evidence, not
 * a claim: it carries the exact output, the exit code and the time it was produced.
 */

interface Check {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

const LEDGER_DIR = process.env["KAAVAL_LEDGER_DIR"] ?? "data/state/ledger";
const OUT_FILE = resolve(process.env["KAAVAL_PROOF_FILE"] ?? "data/state/proof/latest.json");

// The tsx CLI is run by path with this same node binary. Spawning npx would need a shell
// on Windows, which Node warns about, and a shell is not needed to run a file.
const TSX = createRequire(import.meta.url).resolve("tsx/package.json").replace(/package\.json$/, "dist/cli.mjs");

function run(name: string, script: string, args: string[] = []): Check {
  const command = `npx tsx ${script}${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
  const result = spawnSync(process.execPath, [TSX, script, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  const exitCode = result.status ?? 1;
  return { name, command, ok: exitCode === 0, exitCode, output };
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const found = pattern.exec(text);
  return found?.[1] ?? null;
}

const checks: Check[] = [
  run("verify:ledger", "scripts/verify-ledger.ts", [LEDGER_DIR]),
  run("replay", "scripts/replay.ts", [LEDGER_DIR]),
  run("attack", "scripts/attack.ts"),
];

const verifyOutput = checks[0]?.output ?? "";
const entries = firstMatch(verifyOutput, /chain:\s+\w+,\s+(\d+)\s+entries verified/);

const report = {
  generatedAt: new Date().toISOString(),
  ledgerDir: LEDGER_DIR,
  publicKeyHex: firstMatch(verifyOutput, /public key:\s+([0-9a-f]+)/),
  entries: entries === null ? null : Number(entries),
  allPassed: checks.every((check) => check.ok),
  checks,
};

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`proof written to ${OUT_FILE}`);
console.log(`entries:    ${report.entries === null ? "unknown" : String(report.entries)}`);
for (const check of checks) {
  console.log(`${check.name.padEnd(13)} ${check.ok ? "ok" : `FAILED (exit ${String(check.exitCode)})`}`);
}
if (!report.allPassed) process.exitCode = 1;
