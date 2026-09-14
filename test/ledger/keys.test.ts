import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateKeyPair, publicKeyFromHex, publicKeyHexOf, publicKeyPathFor } from "../../src/ledger/keys.js";

// Covers making, reloading and using the signing key. It does not cover file
// permissions, which Windows does not apply the way a Unix mode bit does, and it
// does not cover key rotation, which the ledger has no story for yet.

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kaaval-keys-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadOrCreateKeyPair", () => {
  it("creates the key and its public half on first run, then reuses them", () => {
    const path = join(tempDir(), "secrets", "ledger-key.pem");
    const first = loadOrCreateKeyPair(path);
    expect(existsSync(path)).toBe(true);
    expect(first.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(first.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

    const publicPath = publicKeyPathFor(path);
    expect(publicPath.endsWith("ledger-key.pub.hex")).toBe(true);
    expect(readFileSync(publicPath, "utf8").trim()).toBe(first.publicKeyHex);

    const second = loadOrCreateKeyPair(path);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
  });

  it("gives two different accounts two different keys", () => {
    const dir = tempDir();
    const one = loadOrCreateKeyPair(join(dir, "claude.pem"));
    const two = loadOrCreateKeyPair(join(dir, "qwen.pem"));
    expect(one.publicKeyHex).not.toBe(two.publicKeyHex);
  });

  it("signs and verifies through the published hex", () => {
    const keys = loadOrCreateKeyPair(join(tempDir(), "ledger-key.pem"));
    const message = Buffer.from("kaaval", "utf8");
    const signature = sign(null, message, keys.privateKeyPem);
    expect(verify(null, message, publicKeyFromHex(keys.publicKeyHex), signature)).toBe(true);
    expect(verify(null, Buffer.from("kaava1", "utf8"), publicKeyFromHex(keys.publicKeyHex), signature)).toBe(false);
  });

  it("derives the same hex from the private key alone", () => {
    const keys = loadOrCreateKeyPair(join(tempDir(), "ledger-key.pem"));
    expect(publicKeyHexOf(keys.privateKeyPem)).toBe(keys.publicKeyHex);
  });

  it("refuses a public key that is not 64 hex characters", () => {
    expect(() => publicKeyFromHex("abc")).toThrow(/64 hex/);
    expect(() => publicKeyFromHex("z".repeat(64))).toThrow(/64 hex/);
  });
});
