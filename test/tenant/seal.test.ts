// The round trip, a tampered field, a wrong key, and the input checks around them. Does
// NOT cover where a sealed value is stored, who is allowed to open one, or key rotation:
// the store and the sign-in come from a later work order.
import { describe, expect, it } from "vitest";
import { open, seal, SealError, type Sealed } from "../../src/tenant/seal.js";

const KEY = "1".repeat(64);
const OTHER_KEY = "2".repeat(64);
// Shaped like a Bitget key, but obviously not one: a secrets sweep should never have
// to stop and think about a test fixture.
const SECRET = "not-a-real-bitget-api-key-0123456789";

describe("seal and open", () => {
  it("gives back exactly what was sealed", () => {
    const sealed = seal(SECRET, KEY);
    expect(sealed.v).toBe(1);
    expect(sealed.iv).toHaveLength(24);
    expect(sealed.tag).toHaveLength(32);
    expect(sealed.data).not.toContain(SECRET);
    expect(open(sealed, KEY)).toBe(SECRET);
  });

  it("seals the same secret to a different ciphertext every time", () => {
    const first = seal(SECRET, KEY);
    const second = seal(SECRET, KEY);
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
    expect(open(second, KEY)).toBe(SECRET);
  });

  it("refuses to open a value whose ciphertext was changed", () => {
    const sealed = seal(SECRET, KEY);
    const tampered: Sealed = { ...sealed, data: flipLastByte(sealed.data) };
    expect(() => open(tampered, KEY)).toThrow(SealError);
  });

  it("refuses to open a value whose tag or iv was changed", () => {
    const sealed = seal(SECRET, KEY);
    expect(() => open({ ...sealed, tag: flipLastByte(sealed.tag) }, KEY)).toThrow(/would not open/);
    expect(() => open({ ...sealed, iv: flipLastByte(sealed.iv) }, KEY)).toThrow(/would not open/);
  });

  it("refuses to open with the wrong key, and says nothing about the key", () => {
    const sealed = seal(SECRET, KEY);
    try {
      open(sealed, OTHER_KEY);
      expect.unreachable("opening with the wrong key must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SealError);
      expect((error as Error).message).not.toContain(OTHER_KEY);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it("refuses a key that is not 32 bytes of hex, and an empty secret", () => {
    expect(() => seal(SECRET, "abcd")).toThrow(/64 hex characters/);
    expect(() => seal(SECRET, "z".repeat(64))).toThrow(/64 hex characters/);
    expect(() => seal("", KEY)).toThrow(/nothing to seal/);
  });

  it("reads the key from KAAVAL_KEY_SEAL_HEX when it is not passed in", () => {
    const saved = process.env["KAAVAL_KEY_SEAL_HEX"];
    process.env["KAAVAL_KEY_SEAL_HEX"] = KEY;
    try {
      expect(open(seal(SECRET))).toBe(SECRET);
    } finally {
      if (saved === undefined) delete process.env["KAAVAL_KEY_SEAL_HEX"];
      else process.env["KAAVAL_KEY_SEAL_HEX"] = saved;
    }
  });

  it("refuses a sealed value of an unknown version or a field that is not hex", () => {
    const sealed = seal(SECRET, KEY);
    expect(() => open({ ...sealed, v: 2 as unknown as 1 }, KEY)).toThrow(/version 2/);
    expect(() => open({ ...sealed, data: "not hex" }, KEY)).toThrow(/is not hex/);
    expect(() => open({ ...sealed, iv: "00" }, KEY)).toThrow(/must be 12/);
  });
});

function flipLastByte(hex: string): string {
  const head = hex.slice(0, -2);
  const last = Number.parseInt(hex.slice(-2), 16) ^ 0xff;
  return `${head}${last.toString(16).padStart(2, "0")}`;
}
