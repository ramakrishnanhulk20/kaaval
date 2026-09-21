import "dotenv/config";
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Kaaval's publisher.
 *
 * It copies the parts of the record a stranger is meant to read into a separate git
 * repository, commits them, and pushes when a remote exists. The sites read the same
 * files over plain HTTPS, so the record a judge checks is the record on disk here.
 *
 * Only the files on the allowlist below ever move. The private signing key, the .env and
 * anything named like a secret are refused before a single byte is copied, because this
 * repository is meant to be public.
 *
 *   --once   one cycle, then exit. Without it the script loops on KAAVAL_PUBLISH_MINUTES.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const KAAVAL_ROOT = resolve(HERE, "..");
const PROJECTS_ROOT = resolve(KAAVAL_ROOT, "..");

/** A cycle that takes longer than this is hung. pm2 restarts the process on code 2. */
const CYCLE_TIMEOUT_MS = 5 * 60_000;

/** The proof re-run is the slow part of a cycle, and it is allowed to fail without stopping it. */
const PROOF_TIMEOUT_MS = 3 * 60_000;

const execFileAsync = promisify(execFile);

// The tsx CLI is run by path with this same node binary. Spawning npx would need a shell
// on Windows, which Node warns about, and a shell is not needed to run a file.
const TSX = createRequire(import.meta.url)
  .resolve("tsx/package.json")
  .replace(/package\.json$/, "dist/cli.mjs");

export interface Source {
  ledgerDir: string;
  engineStateFile: string;
  proofFile: string;
  tradesCsvFile: string;
  /** The instrument list the engine last built. Both sites name symbols out of it. */
  universeFile: string;
  publicKeyFile: string;
  reviewsDir: string;
}

export interface Copy {
  from: string;
  to: string;
}

export interface PublishResult {
  entries: number;
  reviews: number;
  copied: number;
  committed: boolean;
  message: string | null;
  remote: "pushed" | "push failed" | "no remote";
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function stamp(line: string): string {
  return `${new Date().toISOString()} ${line}`;
}

function consoleLog(line: string): void {
  console.log(stamp(line));
}

/** Where the engine writes, and where Vidiyal leaves its review bundles. */
export function defaultSource(): Source {
  const state = resolve(KAAVAL_ROOT, "data", "state");
  return {
    ledgerDir: join(state, "ledger"),
    engineStateFile: join(state, "engine.json"),
    proofFile: join(state, "proof", "latest.json"),
    tradesCsvFile: join(state, "trades.csv"),
    universeFile: join(state, "universe.json"),
    publicKeyFile: resolve(KAAVAL_ROOT, "data", "secrets", "ledger-key.pub.hex"),
    reviewsDir: resolve(PROJECTS_ROOT, "vidiyal", "data", "state", "reviews"),
  };
}

export function defaultTarget(): string {
  return resolve(env("KAAVAL_RECORD_DIR", join(PROJECTS_ROOT, "record")));
}

function filesIn(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort();
}

function allNamesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

/**
 * The one rule that keeps this repository publishable: a name that looks like a secret
 * stops the whole run. The check reads every name in the directories the copy walks, not
 * only the names it would have taken, so a key dropped next to the ledger is caught even
 * though the copy would have ignored it.
 */
export function unsafeName(name: string): string | null {
  const lower = basename(name).toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return "an environment file";
  if (lower.endsWith(".pem")) return "a private key file";
  if (lower.includes("ledger-key") && !lower.includes(".pub")) return "the ledger signing key";
  if (lower.includes("secret")) return "a file named as a secret";
  return null;
}

export function assertNoSecrets(source: Source): void {
  if (!source.publicKeyFile.endsWith(".pub.hex")) {
    throw new Error(
      `refusing to publish: the public key path is ${source.publicKeyFile}, which is not a .pub.hex file`,
    );
  }

  const paths: string[] = [
    ...allNamesIn(source.ledgerDir).map((name) => join(source.ledgerDir, name)),
    ...allNamesIn(source.reviewsDir).map((name) => join(source.reviewsDir, name)),
    source.engineStateFile,
    source.proofFile,
    source.tradesCsvFile,
    source.universeFile,
    source.publicKeyFile,
  ];

  for (const path of paths) {
    const reason = unsafeName(path);
    if (reason !== null) {
      throw new Error(`refusing to publish: ${path} looks like ${reason}`);
    }
  }
}

/** The allowlist, and nothing else. A source that is missing is skipped, not invented. */
export function plannedCopies(source: Source, target: string): Copy[] {
  const copies: Copy[] = [];

  for (const name of filesIn(source.ledgerDir, ".jsonl")) {
    copies.push({ from: join(source.ledgerDir, name), to: join(target, "kaaval", "ledger", name) });
  }
  for (const name of publicReviews(source)) {
    copies.push({ from: join(source.reviewsDir, name), to: join(target, "vidiyal", "reviews", name) });
  }

  const singles: Copy[] = [
    { from: source.engineStateFile, to: join(target, "kaaval", "state", "engine.json") },
    { from: source.proofFile, to: join(target, "kaaval", "proof", "latest.json") },
    { from: source.tradesCsvFile, to: join(target, "kaaval", "trades.csv") },
    { from: source.universeFile, to: join(target, "kaaval", "state", "universe.json") },
    { from: source.publicKeyFile, to: join(target, "kaaval", "ledger-key.pub.hex") },
  ];
  for (const copy of singles) {
    if (existsSync(copy.from)) copies.push(copy);
  }

  return copies;
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

export interface KaavalManifest {
  generatedAt: string;
  publicKeyHex: string | null;
  ledgerFiles: Array<{ name: string; entries: number; bytes: number }>;
  engineStateTs: number | null;
  proofGeneratedAt: string | null;
  tradesCsvRows: number;
  /** When the engine last rebuilt its instrument list, so a reader can see how fresh it is. */
  universeBuiltTs: number | null;
}

export type LedgerFile = KaavalManifest["ledgerFiles"][number];

/** One line per day file: how many entries are in it and how big it is. */
export function ledgerFilesOf(source: Source): LedgerFile[] {
  return filesIn(source.ledgerDir, ".jsonl").map((name) => {
    const file = join(source.ledgerDir, name);
    return { name, entries: countLines(file), bytes: statSync(file).size };
  });
}

/**
 * True when the ledger is exactly what the last publish put in the repository. The proof
 * run and the commit are both skipped in that case, so the history only grows on nights
 * the record actually moved. A manifest that is missing or older in shape counts as moved.
 */
export function ledgerUnchanged(current: LedgerFile[], publishedManifest: unknown): boolean {
  if (typeof publishedManifest !== "object" || publishedManifest === null) return false;
  const published = (publishedManifest as Record<string, unknown>)["ledgerFiles"];
  if (!Array.isArray(published) || published.length !== current.length) return false;

  return current.every((file, index) => {
    const was = published[index];
    if (typeof was !== "object" || was === null) return false;
    const row = was as Record<string, unknown>;
    return row["name"] === file.name && row["entries"] === file.entries && row["bytes"] === file.bytes;
  });
}

export function kaavalManifest(source: Source, now: Date = new Date()): KaavalManifest {
  const ledgerFiles = ledgerFilesOf(source);

  const engine = readJson(source.engineStateFile);
  const proof = readJson(source.proofFile);
  const universe = readJson(source.universeFile);

  // The header line is not a trade, so it is not counted as one.
  const csvLines = countLines(source.tradesCsvFile);

  return {
    generatedAt: now.toISOString(),
    publicKeyHex: existsSync(source.publicKeyFile)
      ? readFileSync(source.publicKeyFile, "utf8").trim()
      : null,
    ledgerFiles,
    engineStateTs: engine === null ? null : numberOf(engine["lastTickTs"]),
    proofGeneratedAt: proof === null ? null : stringOf(proof["generatedAt"]),
    tradesCsvRows: csvLines === 0 ? 0 : csvLines - 1,
    universeBuiltTs: universe === null ? null : numberOf(universe["builtTs"]),
  };
}

export interface VidiyalManifest {
  generatedAt: string;
  reviews: Array<{
    name: string;
    source: string | null;
    range: { fromTs: number | null; toTs: number | null } | null;
    graded: number;
    generatedAt: number | null;
  }>;
}

/**
 * The review bundles, described by what they cover. A bundle's own source carries the
 * absolute path it was read from on this machine, so only the kind and the brain go into
 * the manifest.
 */
/**
 * The review bundles that belong in a public record: reviews of Kaaval's own ledger. A
 * review of a trader's Bitget account is theirs, it is named with their account id, and a
 * fixture is not a record of anything, so neither is ever copied out.
 */
function publicReviews(source: Source): string[] {
  return filesIn(source.reviewsDir, ".json").filter((name) => name === "manifest.json" || name.startsWith("kaaval-"));
}

export function vidiyalManifest(source: Source, now: Date = new Date()): VidiyalManifest {
  const reviews: VidiyalManifest["reviews"] = [];

  for (const name of publicReviews(source)) {
    // The review loop's own manifest sits beside the bundles and is not a review.
    if (name === "manifest.json") continue;
    const parsed = readJson(join(source.reviewsDir, name));
    const bundle =
      parsed !== null && typeof parsed["bundle"] === "object" && parsed["bundle"] !== null
        ? (parsed["bundle"] as Record<string, unknown>)
        : null;
    const from =
      bundle !== null && typeof bundle["source"] === "object" && bundle["source"] !== null
        ? (bundle["source"] as Record<string, unknown>)
        : null;
    const range =
      bundle !== null && typeof bundle["range"] === "object" && bundle["range"] !== null
        ? (bundle["range"] as Record<string, unknown>)
        : null;
    const graded = bundle !== null && Array.isArray(bundle["graded"]) ? bundle["graded"].length : 0;

    const kind = from === null ? null : stringOf(from["kind"]);
    const brain = from === null ? null : stringOf(from["brain"]);

    reviews.push({
      name,
      source: kind === null ? null : brain === null ? kind : `${kind}:${brain}`,
      range:
        range === null ? null : { fromTs: numberOf(range["fromTs"]), toTs: numberOf(range["toTs"]) },
      graded,
      generatedAt: parsed === null ? null : numberOf(parsed["generatedAt"]),
    });
  }

  return { generatedAt: now.toISOString(), reviews };
}

/** "record 2026-09-12T14:07Z: 135 ledger entries, 2 reviews". No trailer of any kind. */
export function commitMessage(now: Date, entries: number, reviews: number): string {
  const minute = `${now.toISOString().slice(0, 16)}Z`;
  return `record ${minute}: ${String(entries)} ledger entries, ${String(reviews)} reviews`;
}

const COMMIT_MSG_HOOK = String.raw`#!/bin/sh
msg="$1"
if grep -qiE "co-authored-by|generated with|claude|anthropic|copilot|cursor" "$msg"; then
  echo "commit rejected: agent attribution in message" >&2
  exit 1
fi
if grep -q "$(printf '\342\200\224')" "$msg"; then
  echo "commit rejected: em-dash in message" >&2
  exit 1
fi
exit 0
`;

const PRE_COMMIT_HOOK = String.raw`#!/bin/sh
emdash=$(printf '\342\200\224')
files=$(git diff --cached --name-only --diff-filter=ACM \
  | grep -vE '(^|/)AGENTS\.md$|package-lock\.json$|\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|pdf|lock)$')
[ -z "$files" ] && exit 0
# The record carries the models' own words, quoted. An em-dash in a rationale is theirs to
# write and ours to publish unchanged, so the data files are read for keys but not for style.
prose=$(printf '%s\n' "$files" | grep -vE '^kaaval/ledger/|^vidiyal/reviews/|\.(csv|json)$')
if [ -n "$prose" ]; then
  bad=$(printf '%s\n' "$prose" | xargs -d '\n' grep -l "$emdash" 2>/dev/null)
  if [ -n "$bad" ]; then
    echo "commit rejected: em-dash found in:" >&2
    printf '%s\n' "$bad" >&2
    exit 1
  fi
fi
if printf '%s\n' "$files" | xargs -d '\n' grep -nE "(PRIVATE_KEY|PRIV_KEY|MNEMONIC|SEED_PHRASE|DEPLOYER_KEY|API_SECRET)\s*[=:]\s*['\"]?(0x)?[A-Za-z0-9 ]{16,}|sk_${"live_"}" 2>/dev/null | grep -v "\.env\.example"; then
  echo "commit rejected: something that looks like a private key is staged" >&2
  exit 1
fi
exit 0
`;

function recordReadme(publicKeyHex: string | null): string {
  const key = publicKeyHex ?? "written on the first run that finds the public key";
  return `# The Kaaval record

This repository is the published record of two projects. A publisher beside the engine
refreshes it every 15 minutes.

- \`kaaval/ledger/\` the signed, append-only ledger, one JSONL file per UTC day. Every
  decision, refusal, order, fill and equity mark the trading engine wrote.
- \`kaaval/state/engine.json\` where the engine stood at its last tick.
- \`kaaval/state/universe.json\` the instruments the engine last chose to watch.
- \`kaaval/proof/latest.json\` the last run of the three proofs: verify, replay, attack.
- \`kaaval/trades.csv\` the trade log, rebuilt from the ledger.
- \`kaaval/ledger-key.pub.hex\` the public half of the signing key.
- \`kaaval/manifest.json\` and \`vidiyal/manifest.json\` what is in here right now.
- \`vidiyal/reviews/\` Vidiyal's review bundles: the same trades, graded after the fact.

Kaaval holds no real money. Every fill in this ledger is simulated against a Bitget order
book that was read at that instant and stored beside the fill.

## The signing key

\`\`\`
${key}
\`\`\`

Ed25519. The private half stays on the machine that runs the engine and is never here.

## Verify it yourself

\`\`\`bash
git clone <this repository> record
git clone <the kaaval repository> kaaval
cd kaaval
npm install
npm run verify:ledger -- ../record/kaaval/ledger ../record/kaaval/ledger-key.pub.hex
\`\`\`

The check walks the hash chain, tests every signature against the public key above, and
names the first entry that does not fit. It then recomputes every fill from the order book
recorded beside it.

## What is never here

No private key, no API credential, no environment file. The publisher refuses to run at all
if a file that looks like any of those is sitting in a directory it copies from.
`;
}

const GITATTRIBUTES = `# The ledger is signed byte for byte, so git must not rewrite line endings.
* -text
`;

async function git(
  target: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", target, ...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

/** The owner line in the private STATE.md, when it carries an email. */
function ownerEmailFromState(): string | null {
  const file = resolve(PROJECTS_ROOT, "STATE.md");
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!/owner/i.test(line)) continue;
    const found = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(line);
    if (found) return found[0];
  }
  return null;
}

async function ensureRepo(
  target: string,
  publicKeyHex: string | null,
  log: (line: string) => void,
): Promise<void> {
  mkdirSync(target, { recursive: true });
  if (existsSync(join(target, ".git"))) return;

  const init = await git(target, ["init", "-b", "main"]);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
  log(`created the record repository at ${target}`);

  const name = env("KAAVAL_GIT_NAME", "Ram");
  const email = env("KAAVAL_GIT_EMAIL", ownerEmailFromState() ?? "");
  await git(target, ["config", "user.name", name]);
  if (email === "") {
    log("no KAAVAL_GIT_EMAIL and no owner email in STATE.md: commits need an identity before they run");
  } else {
    await git(target, ["config", "user.email", email]);
  }

  const hooks = join(target, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const [file, body] of [
    ["commit-msg", COMMIT_MSG_HOOK],
    ["pre-commit", PRE_COMMIT_HOOK],
  ] as const) {
    const path = join(hooks, file);
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
  }
  log("installed the commit-msg and pre-commit hooks");

  writeFileSync(join(target, ".gitattributes"), GITATTRIBUTES, "utf8");
  writeFileSync(join(target, "README.md"), recordReadme(publicKeyHex), "utf8");
}

async function refreshProof(log: (line: string) => void): Promise<void> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [TSX, "scripts/proof-web.ts"], {
      cwd: KAAVAL_ROOT,
      timeout: PROOF_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const last = stdout.trim().split("\n").at(-1) ?? "";
    log(`proof refreshed: ${last}`);
  } catch (error) {
    log(`proof could not be refreshed, publishing the stored one: ${(error as Error).message}`);
  }
}

export interface PublishOptions {
  source?: Source;
  target?: string;
  log?: (line: string) => void;
  runProof?: boolean;
  now?: Date;
}

export async function publishOnce(options: PublishOptions = {}): Promise<PublishResult> {
  const source = options.source ?? defaultSource();
  const target = options.target ?? defaultTarget();
  const log = options.log ?? consoleLog;
  const now = options.now ?? new Date();

  const publicKeyHex = existsSync(source.publicKeyFile)
    ? readFileSync(source.publicKeyFile, "utf8").trim()
    : null;

  await ensureRepo(target, publicKeyHex, log);

  const ledgerFiles = ledgerFilesOf(source);
  if (ledgerUnchanged(ledgerFiles, readJson(join(target, "kaaval", "manifest.json")))) {
    log("the ledger has not moved since the last publish, nothing to do");
    return {
      entries: ledgerFiles.reduce((total, file) => total + file.entries, 0),
      reviews: publicReviews(source).length,
      copied: 0,
      committed: false,
      message: null,
      remote: "no remote",
    };
  }

  if (options.runProof !== false) await refreshProof(log);

  assertNoSecrets(source);

  const copies = plannedCopies(source, target);
  const written: string[] = [];
  for (const copy of copies) {
    mkdirSync(dirname(copy.to), { recursive: true });
    copyFileSync(copy.from, copy.to);
    written.push(copy.to);
  }

  const kaaval = kaavalManifest(source, now);
  const vidiyal = vidiyalManifest(source, now);
  const manifests: Array<[string, unknown]> = [
    [join(target, "kaaval", "manifest.json"), kaaval],
    [join(target, "vidiyal", "manifest.json"), vidiyal],
  ];
  for (const [file, body] of manifests) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    written.push(file);
  }
  written.push(join(target, "README.md"), join(target, ".gitattributes"));

  const entries = kaaval.ledgerFiles.reduce((total, file) => total + file.entries, 0);
  const reviews = vidiyal.reviews.length;
  log(
    `copied ${String(copies.length)} files, ${String(entries)} ledger entries, ${String(reviews)} reviews`,
  );

  const add = await git(target, ["add", "--", ...written]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);

  const staged = await git(target, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) {
    log("nothing changed since the last publish");
    return {
      entries,
      reviews,
      copied: copies.length,
      committed: false,
      message: null,
      remote: "no remote",
    };
  }

  const message = commitMessage(now, entries, reviews);
  const commit = await git(target, ["commit", "-m", message]);
  if (commit.code !== 0) {
    throw new Error(`git commit failed: ${`${commit.stdout}${commit.stderr}`.trim()}`);
  }
  log(`committed: ${message}`);

  const origin = await git(target, ["remote", "get-url", "origin"]);
  if (origin.code !== 0) {
    log("no remote yet, kept locally");
    return {
      entries,
      reviews,
      copied: copies.length,
      committed: true,
      message,
      remote: "no remote",
    };
  }

  const push = await git(target, ["push", "origin", "main"]);
  if (push.code !== 0) {
    log(`push failed: ${`${push.stdout}${push.stderr}`.trim()}`);
    return {
      entries,
      reviews,
      copied: copies.length,
      committed: true,
      message,
      remote: "push failed",
    };
  }
  log(`pushed to ${origin.stdout.trim()}`);
  return { entries, reviews, copied: copies.length, committed: true, message, remote: "pushed" };
}

export interface Watchdog {
  timeoutMs: number;
  log: (line: string) => void;
  exit: (code: number) => void;
}

/**
 * Run one cycle against a stopwatch, and end the run if it overruns.
 *
 * A push or a proof run can hang on a socket that never answers, and a promise that is
 * already stuck cannot be cancelled from here. Exiting is the honest recovery: nothing in
 * this script holds state a restart cannot rebuild, and pm2 starts it again. Code 2 says
 * this was the watchdog and not a clean stop. Same pattern as the engine's tick.
 */
export async function watchCycle<T>(work: Promise<T>, dog: Watchdog): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      dog.log(
        `publish watchdog: ${Math.round(dog.timeoutMs / 1000)} seconds, exiting for pm2 to restart`,
      );
      void flushOutput().then(() => {
        dog.exit(2);
        reject(new Error("publish watchdog: the cycle overran its budget"));
      });
    }, dog.timeoutMs);
  });

  try {
    return await Promise.race([work, overrun]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** pm2 hands this process a pipe, and a write to a pipe finishes later than the exit does. */
function flushOutput(graceMs = 1_000): Promise<void> {
  return new Promise((done) => {
    let left = 2;
    const step = (): void => {
      left -= 1;
      if (left === 0) done();
    };
    setTimeout(done, graceMs).unref();
    process.stdout.write("", step);
    process.stderr.write("", step);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const minutes = Number(env("KAAVAL_PUBLISH_MINUTES", "15"));
  const everyMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;

  consoleLog(`publishing ${resolve(KAAVAL_ROOT, "data", "state")} to ${defaultTarget()}`);

  for (;;) {
    const dog: Watchdog = {
      timeoutMs: CYCLE_TIMEOUT_MS,
      log: consoleLog,
      exit: (code) => process.exit(code),
    };
    try {
      await watchCycle(publishOnce(), dog);
    } catch (error) {
      consoleLog(`publish failed, the run continues: ${(error as Error).message}`);
    }
    if (once) return;
    consoleLog(`next publish in ${String(Math.round(everyMs / 60_000))} minutes`);
    await sleep(everyMs);
  }
}

// The tests pull the pure parts out of this file, so loading the module must not publish.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
