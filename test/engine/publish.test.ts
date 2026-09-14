// The publisher: what it refuses to copy, what the manifests say, and the commit it makes.
// Does NOT cover pushing to a real remote (no network here), the proof re-run (skipped with
// runProof false), pm2 running it every 15 minutes, or whether GitHub serves the files it
// pushed. Every test works on a temporary source tree, never on the live record.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  commitMessage,
  kaavalManifest,
  ledgerFilesOf,
  ledgerUnchanged,
  plannedCopies,
  publishOnce,
  unsafeName,
  vidiyalManifest,
  watchCycle,
  type Source,
  type Watchdog,
} from "../../scripts/publish-record.js";

const NOW = new Date("2026-09-12T14:07:31.000Z");

const ENTRY_ONE = JSON.stringify({ seq: 1, ts: 1789114889143, kind: "config", account: "kaaval", payload: {} });
const ENTRY_TWO = JSON.stringify({ seq: 2, ts: 1789114890000, kind: "mark", account: "rules", payload: { equity: 10_000 } });

const REVIEW = {
  generatedAt: 1789198771772,
  bundle: {
    source: { kind: "ledger", dir: "C:\\somewhere\\ledger", brain: "claude" },
    range: { fromTs: 1789114889143, toTs: 1789115151618 },
    graded: [{ trade: { id: "ledger:6>open" } }, { trade: { id: "ledger:8>open" } }],
  },
};

function makeSource(root: string): Source {
  const ledgerDir = join(root, "state", "ledger");
  const reviewsDir = join(root, "reviews");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(reviewsDir, { recursive: true });
  mkdirSync(join(root, "state", "proof"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });

  writeFileSync(join(ledgerDir, "2026-09-11.jsonl"), `${ENTRY_ONE}\n${ENTRY_TWO}\n`, "utf8");
  writeFileSync(join(root, "state", "engine.json"), JSON.stringify({ lastTickTs: 1789200034886 }), "utf8");
  writeFileSync(
    join(root, "state", "proof", "latest.json"),
    JSON.stringify({ generatedAt: "2026-09-12T07:46:14.796Z", allPassed: true }),
    "utf8",
  );
  writeFileSync(
    join(root, "state", "trades.csv"),
    "timestamp,instrument,direction,price,quantity,balanceChange,balanceAfter,account,note\n2026-09-11T08:21:29.143Z,RNVDAUSDT,buy,220,1.74,-383.9,9616.1,claude,open\n",
    "utf8",
  );
  writeFileSync(join(root, "secrets", "ledger-key.pub.hex"), `${"41".repeat(32)}\n`, "utf8");
  writeFileSync(
    join(root, "state", "universe.json"),
    JSON.stringify({
      entries: [{ rToken: { symbol: "RNVDAUSDT", baseCoin: "rNVDA" } }],
      hedges: [],
      builtTs: 1789201035795,
    }),
    "utf8",
  );
  writeFileSync(join(reviewsDir, "kaaval-claude.json"), JSON.stringify(REVIEW), "utf8");

  return {
    ledgerDir,
    engineStateFile: join(root, "state", "engine.json"),
    proofFile: join(root, "state", "proof", "latest.json"),
    tradesCsvFile: join(root, "state", "trades.csv"),
    universeFile: join(root, "state", "universe.json"),
    publicKeyFile: join(root, "secrets", "ledger-key.pub.hex"),
    reviewsDir,
  };
}

let root = "";
let target = "";
let source: Source;
const savedEnv = { name: process.env["KAAVAL_GIT_NAME"], email: process.env["KAAVAL_GIT_EMAIL"] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kaaval-source-"));
  target = mkdtempSync(join(tmpdir(), "kaaval-record-"));
  source = makeSource(root);
  process.env["KAAVAL_GIT_NAME"] = "Ram";
  process.env["KAAVAL_GIT_EMAIL"] = "record@kaaval.test";
});

afterEach(() => {
  if (savedEnv.name === undefined) delete process.env["KAAVAL_GIT_NAME"];
  else process.env["KAAVAL_GIT_NAME"] = savedEnv.name;
  if (savedEnv.email === undefined) delete process.env["KAAVAL_GIT_EMAIL"];
  else process.env["KAAVAL_GIT_EMAIL"] = savedEnv.email;
});

describe("the secrets guard", () => {
  it("refuses the whole run when an environment file sits next to the ledger", async () => {
    writeFileSync(join(source.ledgerDir, ".env"), "ANTHROPIC_API_KEY=nope\n", "utf8");

    await expect(publishOnce({ source, target, runProof: false, log: () => {} })).rejects.toThrow(
      /refusing to publish: .* looks like an environment file/,
    );
    expect(existsSync(join(target, "kaaval", "ledger"))).toBe(false);
  });

  it("refuses the whole run when the private signing key sits next to the reviews", async () => {
    writeFileSync(join(source.reviewsDir, "ledger-key.pem"), "not a real key\n", "utf8");

    await expect(publishOnce({ source, target, runProof: false, log: () => {} })).rejects.toThrow(
      /refusing to publish: .* looks like a private key file/,
    );
    expect(existsSync(join(target, "vidiyal", "reviews"))).toBe(false);
  });

  it("names what each kind of file looks like, and lets the public half through", () => {
    expect(unsafeName("/x/.env.local")).toBe("an environment file");
    expect(unsafeName("/x/ledger-key.pem")).toBe("a private key file");
    expect(unsafeName("/x/ledger-key")).toBe("the ledger signing key");
    expect(unsafeName("/x/bitget-secrets.json")).toBe("a file named as a secret");
    expect(unsafeName("/x/ledger-key.pub.hex")).toBeNull();
    expect(unsafeName("/x/2026-09-11.jsonl")).toBeNull();
  });

  it("refuses a public key path that is not the public half", () => {
    expect(() => {
      assertNoSecrets({ ...source, publicKeyFile: join(root, "secrets", "ledger-key.pem") });
    }).toThrow(/not a .pub.hex file/);
  });
});

describe("the allowlist", () => {
  it("takes the seven allowed things and leaves anything else in the source alone", () => {
    writeFileSync(join(source.ledgerDir, "notes.txt"), "scratch\n", "utf8");
    writeFileSync(join(root, "state", "scratch.json"), "{}", "utf8");

    const copies = plannedCopies(source, target).map((copy) => copy.to.slice(target.length + 1));

    expect(copies.map((path) => path.split(/[\\/]/).join("/"))).toEqual([
      "kaaval/ledger/2026-09-11.jsonl",
      "vidiyal/reviews/kaaval-claude.json",
      "kaaval/state/engine.json",
      "kaaval/proof/latest.json",
      "kaaval/trades.csv",
      "kaaval/state/universe.json",
      "kaaval/ledger-key.pub.hex",
    ]);
  });
});

describe("the manifests", () => {
  it("counts the ledger entries and the trade rows without the header", () => {
    const manifest = kaavalManifest(source, NOW);

    expect(manifest.generatedAt).toBe("2026-09-12T14:07:31.000Z");
    expect(manifest.publicKeyHex).toBe("41".repeat(32));
    expect(manifest.ledgerFiles).toEqual([
      { name: "2026-09-11.jsonl", entries: 2, bytes: `${ENTRY_ONE}\n${ENTRY_TWO}\n`.length },
    ]);
    expect(manifest.engineStateTs).toBe(1789200034886);
    expect(manifest.proofGeneratedAt).toBe("2026-09-12T07:46:14.796Z");
    expect(manifest.tradesCsvRows).toBe(1);
    expect(manifest.universeBuiltTs).toBe(1789201035795);
  });

  it("says the universe is absent rather than inventing a build time", () => {
    const without = { ...source, universeFile: join(root, "state", "gone.json") };

    expect(kaavalManifest(without, NOW).universeBuiltTs).toBeNull();
    expect(plannedCopies(without, target)).not.toContainEqual(
      expect.objectContaining({ to: join(target, "kaaval", "state", "universe.json") }),
    );
  });

  it("describes each review without publishing the path it was read from", () => {
    const manifest = vidiyalManifest(source, NOW);

    expect(manifest.reviews).toEqual([
      {
        name: "kaaval-claude.json",
        source: "ledger:claude",
        range: { fromTs: 1789114889143, toTs: 1789115151618 },
        graded: 2,
        generatedAt: 1789198771772,
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain("somewhere");
  });
});

describe("the commit", () => {
  it("reads as a record line with no trailer", () => {
    expect(commitMessage(NOW, 135, 2)).toBe("record 2026-09-12T14:07Z: 135 ledger entries, 2 reviews");
  });

  it(
    "creates the repository, commits once with no attribution, and says there is no remote",
    async () => {
      const lines: string[] = [];
      const first = await publishOnce({ source, target, runProof: false, now: NOW, log: (line) => lines.push(line) });

      expect(first.committed).toBe(true);
      expect(first.remote).toBe("no remote");
      expect(lines).toContain("no remote yet, kept locally");
      expect(existsSync(join(target, ".git", "hooks", "pre-commit"))).toBe(true);
      expect(readFileSync(join(target, "README.md"), "utf8")).toContain("41".repeat(32));

      const log = execFileSync("git", ["-C", target, "log", "--format=%B"], { encoding: "utf8" });
      expect(log).toContain("record 2026-09-12T14:07Z: 2 ledger entries, 1 reviews");
      expect(log).not.toMatch(/co-authored|generated with|anthropic/i);

      const second = await publishOnce({ source, target, runProof: false, now: NOW, log: () => {} });
      expect(second.committed).toBe(false);
    },
    30_000,
  );
});

describe("quiet history", () => {
  it("calls the ledger unchanged only when every day file is the same size and count", () => {
    const current = ledgerFilesOf(source);

    expect(ledgerUnchanged(current, { ledgerFiles: current })).toBe(true);
    expect(ledgerUnchanged(current, { ledgerFiles: [{ ...current[0], bytes: 1 }] })).toBe(false);
    expect(ledgerUnchanged(current, { ledgerFiles: [] })).toBe(false);
    expect(ledgerUnchanged(current, null)).toBe(false);
  });

  it(
    "publishes again as soon as the ledger moves",
    async () => {
      await publishOnce({ source, target, runProof: false, now: NOW, log: () => {} });

      const lines: string[] = [];
      const quiet = await publishOnce({ source, target, runProof: false, now: NOW, log: (line) => lines.push(line) });
      expect(quiet.committed).toBe(false);
      expect(lines).toContain("the ledger has not moved since the last publish, nothing to do");

      appendFileSync(join(source.ledgerDir, "2026-09-11.jsonl"), `${ENTRY_TWO}\n`, "utf8");
      const moved = await publishOnce({
        source,
        target,
        runProof: false,
        now: new Date("2026-09-12T14:22:00.000Z"),
        log: () => {},
      });

      expect(moved.committed).toBe(true);
      expect(moved.entries).toBe(3);
    },
    30_000,
  );
});

describe("watchCycle", () => {
  it("exits with code 2 when a cycle never comes back", async () => {
    const codes: number[] = [];
    const lines: string[] = [];
    const dog: Watchdog = { timeoutMs: 50, log: (line) => lines.push(line), exit: (code) => codes.push(code) };

    await expect(watchCycle(new Promise<never>(() => {}), dog)).rejects.toThrow(/overran its budget/);

    expect(codes).toEqual([2]);
    expect(lines).toContain("publish watchdog: 0 seconds, exiting for pm2 to restart");
  });

  it("gives a cycle that finishes in time its own answer", async () => {
    const dog: Watchdog = { timeoutMs: 2_000, log: () => {}, exit: () => {} };
    await expect(watchCycle(Promise.resolve("done"), dog)).resolves.toBe("done");
  });
});
