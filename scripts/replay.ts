import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicKeyPathFor } from "../src/ledger/keys.js";
import { replayFills, verifyLedger } from "../src/ledger/ledger.js";

/**
 * Re-runs the whole record: the hash chain and the signatures first, then every fill
 * against the order book snapshot it names. A pass means nobody edited the ledger and
 * every trade in it could really have happened on the book we recorded at that instant.
 */

const dir = resolve(process.argv.slice(2).filter((arg) => arg !== "--")[0] ?? process.env["KAAVAL_LEDGER_DIR"] ?? "data/state/ledger");
const keyFile = resolve(process.env["KAAVAL_LEDGER_KEY"] ?? "data/secrets/ledger-key.pem");
const publicKeyFile = publicKeyPathFor(keyFile);

if (!existsSync(publicKeyFile)) {
  console.error(`No public key at ${publicKeyFile}. Run the engine once to create the signing key.`);
  process.exit(1);
}

const publicKeyHex = readFileSync(publicKeyFile, "utf8").trim();
const check = verifyLedger(dir, publicKeyHex);
console.log(`ledger:     ${dir}`);
console.log(`chain:      ${check.ok ? "ok" : "BROKEN"}, ${check.entries} entries verified`);
if (!check.ok) {
  console.log(`first bad:  entry ${check.firstBad ?? "unknown"}`);
  console.log(`reason:     ${check.reason ?? "unknown"}`);
  process.exit(1);
}

let replay: ReturnType<typeof replayFills>;
try {
  replay = replayFills(dir);
} catch (error) {
  console.log(`replay:     could not run. ${(error as Error).message}`);
  process.exit(1);
}

const mismatches = replay.filter((row) => !row.matches);
console.log(`replay:     ${replay.length - mismatches.length} of ${replay.length} fills reproduce from the recorded books`);
const first = mismatches[0];
if (first) {
  console.log(
    `first bad:  entry ${first.seq}, recorded ${first.recorded.qty} at ${first.recorded.avgPrice}, the book gives ${first.expected.qty} at ${first.expected.avgPrice}`,
  );
  process.exit(1);
}

console.log("replay:     ok");
