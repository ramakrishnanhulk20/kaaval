import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * A trader's Bitget key at rest: AES-256-GCM, every field hex.
 *
 * v is the format version, so a later key rotation or cipher change can be told apart
 * from a corrupt row without guessing. The tag is GCM's authentication tag and it is
 * what makes a changed iv, a changed ciphertext or a wrong key fail loudly instead of
 * returning rubbish that later looks like a bad API key.
 */
export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/** Thrown for a bad key, a bad input or a value that would not open. Carries no secret. */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

const KEY_ENV = "KAAVAL_KEY_SEAL_HEX";

/** 12 bytes is the IV size AES-GCM is defined for, and the only one node accepts without a tweak. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX_LENGTH = 64;

/**
 * Seals one secret under the server key.
 *
 * A fresh random IV per call is the whole safety of GCM: the same key sealing the same
 * API key twice must never produce the same ciphertext, or two identical rows in a
 * database would tell a reader that two traders pasted the same key.
 *
 * Throws SealError when the key is missing or malformed, or when plain is empty. It
 * never puts the key or the plaintext in the message, because these errors get logged.
 */
export function seal(plain: string, keyHex?: string): Sealed {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new SealError("there is nothing to seal: the value is empty");
  }
  const key = keyOf(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}

/**
 * Opens a sealed secret, or throws.
 *
 * A wrong key and a tampered field fail the same way on purpose: the caller learns that
 * this value cannot be trusted, and learns nothing about which of the two it was.
 */
export function open(sealed: Sealed, keyHex?: string): string {
  const key = keyOf(keyHex);
  if (sealed === null || typeof sealed !== "object") {
    throw new SealError("that is not a sealed value");
  }
  if (sealed.v !== 1) {
    throw new SealError(`this build opens sealed values of version 1, that one is version ${String(sealed.v)}`);
  }
  const iv = hexField(sealed.iv, IV_BYTES, "iv");
  const tag = hexField(sealed.tag, TAG_BYTES, "tag");
  const data = hexField(sealed.data, null, "data");

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new SealError(
      "that sealed value would not open: it was sealed with a different key, or one of its fields has been changed",
    );
  }
}

function keyOf(keyHex?: string): Buffer {
  const raw = (keyHex ?? process.env[KEY_ENV] ?? "").trim();
  if (raw === "") {
    throw new SealError(`no sealing key: pass one in or set ${KEY_ENV} to ${KEY_HEX_LENGTH} hex characters`);
  }
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_HEX_LENGTH) {
    throw new SealError(`the sealing key must be exactly ${KEY_HEX_LENGTH} hex characters, which is 32 bytes`);
  }
  return Buffer.from(raw, "hex");
}

function hexField(value: unknown, bytes: number | null, name: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new SealError(`the sealed value's ${name} is not hex`);
  }
  if (bytes !== null && value.length !== bytes * 2) {
    throw new SealError(`the sealed value's ${name} is ${value.length / 2} bytes, it must be ${bytes}`);
  }
  return Buffer.from(value, "hex");
}
