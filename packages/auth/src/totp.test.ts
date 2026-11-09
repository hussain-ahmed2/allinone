import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  consumeRecoveryCode,
  generateRecoveryCodes,
  totpCode,
  TotpVerifier,
  verifyTotpCode,
} from "./totp.js";

/** RFC 6238 Appendix B vectors (SHA1, secret "12345678901234567890"). */
const SECRET = Buffer.from("12345678901234567890", "ascii");
const VECTORS: [seconds: number, code8: string][] = [
  [59, "94287082"],
  [1_111_111_109, "07081804"],
  [1_111_111_111, "14050471"],
  [1_234_567_890, "89005924"],
  [2_000_000_000, "69279037"],
  [20_000_000_000, "65353130"],
];

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const original = Buffer.from("Hello, allinone TOTP!", "utf8");
    expect(base32Decode(base32Encode(original))).toEqual(original);
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("N0T!VALID")).toThrow(/Invalid base32/);
  });
});

describe("totpCode RFC 6238 vectors", () => {
  for (const [seconds, expected] of VECTORS) {
    it(`T=${String(seconds)} → ${expected} (8 digits)`, () => {
      expect(totpCode(SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
    });
  }

  it("6-digit codes are the last 6 of 8-digit codes", () => {
    expect(totpCode(SECRET, 59 * 1000, { digits: 6 })).toBe("287082");
  });
});

describe("verifyTotpCode window", () => {
  it("accepts current + adjacent steps, rejects others", () => {
    const time = 1_234_567_890_000;
    const current = totpCode(SECRET, time);
    const next = totpCode(SECRET, time + 30_000);
    expect(verifyTotpCode(SECRET, current, time)).toBe(true);
    expect(verifyTotpCode(SECRET, next, time)).toBe(true);
    const far = totpCode(SECRET, time + 120_000);
    expect(verifyTotpCode(SECRET, far, time)).toBe(false);
    expect(verifyTotpCode(SECRET, "not-a-code", time)).toBe(false);
  });
});

describe("TotpVerifier replay protection", () => {
  it("never accepts the same counter twice", () => {
    const verifier = new TotpVerifier();
    const time = 1_234_567_890_000;
    const code = totpCode(SECRET, time);
    expect(verifier.verify("u1", SECRET, code, time)).toBe(true);
    // Same code, same window — replay rejected.
    expect(verifier.verify("u1", SECRET, code, time)).toBe(false);
    // A new valid code (next step) still works.
    expect(verifier.verify("u1", SECRET, totpCode(SECRET, time + 30_000), time)).toBe(true);
  });

  it("replay state is per-user", () => {
    const verifier = new TotpVerifier();
    const time = 1_234_567_890_000;
    const code = totpCode(SECRET, time);
    expect(verifier.verify("u1", SECRET, code, time)).toBe(true);
    expect(verifier.verify("u2", SECRET, code, time)).toBe(true);
  });
});

describe("recovery codes", () => {
  it("generate + consume single-use codes", () => {
    const { codes, hashes } = generateRecoveryCodes(3);
    expect(codes).toHaveLength(3);
    expect(codes[0]).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const first = consumeRecoveryCode(hashes, codes[0]!);
    expect(first.consumed).toBe(true);
    expect(first.remaining).toBe(2);
    // Reuse rejected.
    expect(consumeRecoveryCode(hashes, codes[0]!).consumed).toBe(false);
    // Unknown code rejected.
    expect(consumeRecoveryCode(hashes, "XXXX-XXXX").consumed).toBe(false);
  });
});
