import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProof, type ProofRun } from "./proof-format";
import { fetchProof, recordUrl } from "./record-http";
import { dataDir } from "./record";

export function proofFile(): string {
  return join(dataDir(), "proof", "latest.json");
}

/**
 * The last run of the three proofs, as npm run proof:web stored it. A host reading the
 * published record fetches the same file over HTTPS instead of off the disk.
 */
export async function getStoredProof(note: string | null = null): Promise<ProofRun | null> {
  if (recordUrl() !== null) {
    try {
      const stored = await fetchProof();
      return stored === null ? null : parseProof(stored, true, note);
    } catch {
      return null;
    }
  }

  const file = proofFile();
  if (!existsSync(file)) return null;
  try {
    return parseProof(JSON.parse(readFileSync(file, "utf8")), true, note);
  } catch {
    return null;
  }
}

export { parseProof };
export type { ProofCheck, ProofRun } from "./proof-format";
