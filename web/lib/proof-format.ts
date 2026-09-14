export interface ProofCheck {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface ProofRun {
  generatedAt: string | null;
  ledgerDir: string | null;
  publicKeyHex: string | null;
  entries: number | null;
  allPassed: boolean;
  checks: ProofCheck[];
  /** Set when this run came from the stored file rather than from a run just now. */
  stored: boolean;
  /** Why the fresh run did not happen, when it did not. */
  note: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseProof(value: unknown, stored: boolean, note: string | null = null): ProofRun | null {
  if (!isRecord(value)) return null;
  const rawChecks = Array.isArray(value["checks"]) ? value["checks"] : [];
  const checks: ProofCheck[] = [];
  for (const item of rawChecks) {
    if (!isRecord(item)) continue;
    checks.push({
      name: typeof item["name"] === "string" ? item["name"] : "check",
      command: typeof item["command"] === "string" ? item["command"] : "",
      ok: item["ok"] === true,
      exitCode: typeof item["exitCode"] === "number" ? item["exitCode"] : 1,
      output: typeof item["output"] === "string" ? item["output"] : "",
    });
  }
  if (checks.length === 0) return null;

  return {
    generatedAt: typeof value["generatedAt"] === "string" ? value["generatedAt"] : null,
    ledgerDir: typeof value["ledgerDir"] === "string" ? value["ledgerDir"] : null,
    publicKeyHex: typeof value["publicKeyHex"] === "string" ? value["publicKeyHex"] : null,
    entries: typeof value["entries"] === "number" ? value["entries"] : null,
    allPassed: value["allPassed"] === true,
    checks,
    stored,
    note,
  };
}

export interface AttackTable {
  headers: string[];
  rows: string[][];
  summary: string[];
  intro: string[];
}

const ATTACK_HEADERS = ["scenario", "what the brain was told", "expected", "outcome", "rule"];

/**
 * The attack script prints a fixed width table. The column edges are read off the header
 * line rather than guessed, and anything that does not parse comes back null so the panel
 * can fall back to showing the raw output instead of inventing a row.
 */
export function attackTable(output: string): AttackTable | null {
  const lines = output.split("\n");
  const headerIndex = lines.findIndex(
    (line) => ATTACK_HEADERS.every((name) => line.includes(name)),
  );
  if (headerIndex < 0) return null;
  const header = lines[headerIndex];
  if (header === undefined) return null;

  const starts = ATTACK_HEADERS.map((name) => header.indexOf(name));
  if (starts.some((start) => start < 0)) return null;

  const slice = (line: string): string[] =>
    starts.map((start, index) => {
      const end = index + 1 < starts.length ? starts[index + 1] : line.length;
      return line.slice(start, end).trim();
    });

  // The table body runs from the rule of dashes under the header to the first blank
  // line; everything after that blank line is the count the script signs off with.
  const rows: string[][] = [];
  const summary: string[] = [];
  let index = headerIndex + 1;
  while (index < lines.length && /^[-\s]*$/.test(lines[index] ?? "")) index += 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    rows.push(slice(line));
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "") summary.push(line.trim());
  }
  if (rows.length === 0) return null;

  return {
    headers: ATTACK_HEADERS,
    rows,
    summary,
    intro: lines.slice(0, headerIndex).filter((line) => line.trim() !== ""),
  };
}

/** The label and value lines the ledger check and the replay print. */
export function checkLines(output: string): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at < 0) {
      lines.push(["", line.trim()]);
      continue;
    }
    lines.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return lines;
}
