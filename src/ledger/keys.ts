import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface KeyPair {
  publicKeyHex: string;
  privateKeyPem: string;
}

/** The public half sits next to the private half so a verifier never needs the secret. */
export function publicKeyPathFor(filePath: string): string {
  const extension = extname(filePath);
  const stem = extension ? basename(filePath, extension) : basename(filePath);
  return join(dirname(filePath), `${stem}.pub.hex`);
}

export function publicKeyHexOf(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" }) as { crv?: string; x?: string };
  if (jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("that private key is not an Ed25519 key");
  }
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

export function publicKeyFromHex(publicKeyHex: string): KeyObject {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    throw new Error("an Ed25519 public key is 64 hex characters");
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") },
    format: "jwk",
  });
}

/**
 * Reads the signing key at filePath, or makes one on first run. The private key is
 * written once with owner-only permissions and is never returned to a log or printed:
 * callers get the PEM to sign with and the public hex to publish.
 */
export function loadOrCreateKeyPair(filePath: string): KeyPair {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });

  let privateKeyPem: string;
  if (existsSync(filePath)) {
    privateKeyPem = readFileSync(filePath, "utf8");
  } else {
    const generated = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    privateKeyPem = generated.privateKey;
    writeFileSync(filePath, privateKeyPem, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  const publicKeyHex = publicKeyHexOf(privateKeyPem);
  const publicPath = publicKeyPathFor(filePath);
  if (!existsSync(publicPath) || readFileSync(publicPath, "utf8").trim() !== publicKeyHex) {
    writeFileSync(publicPath, `${publicKeyHex}\n`, { encoding: "utf8", mode: 0o644 });
  }

  return { publicKeyHex, privateKeyPem };
}
