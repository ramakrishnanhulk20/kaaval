import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { getStoredProof, parseProof, proofFile } from "@/lib/proof";
import { dataDir } from "@/lib/record";

export const dynamic = "force-dynamic";
export const maxDuration = 200;

const run = promisify(execFile);

/** The engine folder: the state directory is data/state inside it. */
function engineDir(): string {
  return resolve(dataDir(), "..", "..");
}

/**
 * Runs the three proofs again on the machine that holds the ledger and returns what they
 * printed. A host without the engine beside it cannot run anything, so it answers with the
 * last stored run and says exactly that rather than pretending it just checked.
 */
export async function POST(): Promise<Response> {
  if (process.env.KAAVAL_PROOF_RUNNER !== "local") {
    const stored = await getStoredProof(
      "This host does not run the engine, so nothing was re-run. This is the last stored run from the machine that holds the ledger.",
    );
    if (!stored) {
      return Response.json({ error: "No stored proof run was found on this host." }, { status: 404 });
    }
    return Response.json(stored, { headers: { "cache-control": "no-store" } });
  }

  try {
    await run("npx", ["tsx", "scripts/proof-web.ts"], {
      cwd: engineDir(),
      timeout: 180_000,
      windowsHide: true,
      shell: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    // The script writes the report even when a check fails and exits non zero, so a fresh
    // file is still the answer; only a run that produced nothing is an error.
    const message = error instanceof Error ? error.message : String(error);
    const fresh = readFresh();
    if (!fresh) {
      return Response.json({ error: `The proof run failed: ${message}` }, { status: 500 });
    }
    return Response.json(fresh, { headers: { "cache-control": "no-store" } });
  }

  const fresh = readFresh();
  if (!fresh) {
    return Response.json(
      { error: "The proof run wrote no report. Check the engine folder." },
      { status: 500 },
    );
  }
  return Response.json(fresh, { headers: { "cache-control": "no-store" } });
}

function readFresh(): ReturnType<typeof parseProof> {
  try {
    return parseProof(JSON.parse(readFileSync(proofFile(), "utf8")), false);
  } catch {
    return null;
  }
}
