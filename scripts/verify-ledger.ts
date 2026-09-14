import { existsSync, readFileSync } from "node:fs";
import { replayFills, verifyLedger } from "../src/ledger/ledger.js";
import { publicKeyPathFor } from "../src/ledger/keys.js";

const DEFAULT_LEDGER_DIR = "data/state/ledger";
const DEFAULT_KEY_FILE = "data/secrets/ledger-key.pem";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const dir = args[0] ?? DEFAULT_LEDGER_DIR;
const publicKeyFile = args[1] ?? publicKeyPathFor(DEFAULT_KEY_FILE);

if (!existsSync(publicKeyFile)) {
  console.error(`No public key at ${publicKeyFile}. Run the ledger demo or the engine once to create the signing key.`);
  process.exit(1);
}

const publicKeyHex = readFileSync(publicKeyFile, "utf8").trim();
const check = verifyLedger(dir, publicKeyHex);

console.log(`ledger:     ${dir}`);
console.log(`public key: ${publicKeyHex}`);
console.log(`chain:      ${check.ok ? "ok" : "BROKEN"}, ${check.entries} entries verified`);
if (!check.ok) {
  console.log(`first bad:  entry ${check.firstBad ?? "unknown"}`);
  console.log(`reason:     ${check.reason ?? "unknown"}`);
  process.exit(1);
}

let mismatches = 0;
try {
  const replay = replayFills(dir);
  mismatches = replay.filter((row) => !row.matches).length;
  console.log(`replay:     ${replay.length - mismatches} of ${replay.length} fills reproduce from the recorded books`);
  for (const row of replay) {
    if (row.matches) continue;
    console.log(
      `  entry ${row.seq}: recorded ${row.recorded.qty} at ${row.recorded.avgPrice}, the book gives ${row.expected.qty} at ${row.expected.avgPrice}`,
    );
  }
} catch (error) {
  console.log(`replay:     could not run. ${(error as Error).message}`);
  process.exit(1);
}

process.exit(mismatches === 0 ? 0 : 1);
