/**
 * TOTP (RFC 6238) + recovery codes — zero-dependency (node:crypto only).
 *
 * Security rules:
 *  - Secrets are random 20-byte values, base32-encoded for authenticator
 *    apps via `otpauth://` URIs (the secret itself never leaves logs).
 *  - Codes are 6 digits, 30-second step, HMAC-SHA1, verified with a
 *    ±1 step window to tolerate clock skew.
 *  - Replay protection: each accepted counter is recorded per user;
 *    the same counter can never be used twice — even within the window.
 *  - Recovery codes are single-use, stored ONLY as SHA-256 hashes.
 */
import { createHmac, randomBytes } from "node:crypto";
import { generateToken, hashToken } from "./auth.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32-encode bytes (RFC 4648, no padding). */
export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  }
  return output;
}

/** Base32-decode (tolerates lowercase + optional padding). */
export function base32Decode(input: string): Buffer {
  const normalized = input.replace(/-/g, "").replace(/=/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`[allinone/auth] Invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  digits?: 6 | 8;
  stepSeconds?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

function counterFor(timeMs: number, stepSeconds: number): number {
  return Math.floor(timeMs / 1000 / stepSeconds);
}

/**
 * Totp code for a given time (default: now). Pure — testable with
 * RFC 6238 test vectors.
 */
export function totpCode(secret: Buffer, timeMs = Date.now(), options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const step = options.stepSeconds ?? 30;
  const algorithm = options.algorithm ?? "sha1";
  const counter = counterFor(timeMs, step);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac(algorithm, secret).update(counterBuffer).digest();
  const byte = (index: number): number => hash[index] ?? 0;
  const offset = byte(hash.length - 1) & 0x0f;
  const code =
    ((byte(offset) & 0x7f) << 24) |
    ((byte(offset + 1) & 0xff) << 16) |
    ((byte(offset + 2) & 0xff) << 8) |
    (byte(offset + 3) & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/**
 * Verify a Totp code within a ±1 step window.
 * No replay state — see `TotpVerifier` for stateful verification.
 */
export function verifyTotpCode(
  secret: Buffer,
  code: string,
  timeMs = Date.now(),
  options: TotpOptions = {},
): boolean {
  if (!/^\d{6,8}$/.test(code)) return false;
  const step = options.stepSeconds ?? 30;
  for (const drift of [-step, 0, step]) {
    if (totpCode(secret, timeMs + drift * 1000, options) === code) return true;
  }
  return false;
}

/**
 * Stateful Totp verifier with replay protection.
 * Records the highest accepted counter per user — a code covering an
 * already-seen counter is rejected even inside the time window.
 */
export class TotpVerifier {
  readonly #lastAccepted = new Map<string, number>();
  private readonly options: TotpOptions;

  constructor(options: TotpOptions = {}) {
    this.options = options;
  }

  verify(userId: string, secret: Buffer, code: string, timeMs = Date.now()): boolean {
    if (!/^\d{6,8}$/.test(code)) return false;
    const step = this.options.stepSeconds ?? 30;
    const current = counterFor(timeMs, step);
    for (const drift of [-1, 0, 1]) {
      const counter = current + drift;
      if (totpCode(secret, counter * step * 1000, this.options) !== code) continue;
      const last = this.#lastAccepted.get(userId) ?? -1;
      if (counter <= last) return false;
      this.#lastAccepted.set(userId, counter);
      return true;
    }
    return false;
  }
}

/** Generate a random Totp secret (returns raw bytes + base32 form). */
export function generateTotpSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(20);
  return { secret, base32: base32Encode(secret) };
}

/** Build an `otpauth://` URI for authenticator apps / QR codes. */
export function totpUri(input: {
  secret: string;
  account: string;
  issuer: string;
  digits?: 6 | 8;
  stepSeconds?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: (input.algorithm ?? "sha1").toUpperCase(),
    digits: String(input.digits ?? 6),
    period: String(input.stepSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                       */
/* ------------------------------------------------------------------ */

export interface RecoveryCodeSet {
  /** Plaintext codes — show ONCE at enrollment, then discard. */
  codes: string[];
  /** SHA-256 hashes — the only thing ever persisted. */
  hashes: Set<string>;
}

/** Generate single-use recovery codes (default 8, 10 chars, A–Z0–9). */
export function generateRecoveryCodes(count = 8): RecoveryCodeSet {
  const codes: string[] = [];
  const hashes = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const raw = randomBytes(8)
      .toString("base64url")
      .replace(/[^A-Z0-9]/gi, "")
      .toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    codes.push(code);
    hashes.add(hashToken(code));
  }
  return { codes, hashes };
}

/**
 * Consume a recovery code if valid. On success the hash is removed
 * (single-use); on failure nothing changes. Returns remaining count.
 */
export function consumeRecoveryCode(
  hashes: Set<string>,
  code: string,
): { consumed: boolean; remaining: number } {
  const normalized = code.trim().toUpperCase();
  const hash = hashToken(normalized);
  if (hashes.has(hash)) {
    hashes.delete(hash);
    return { consumed: true, remaining: hashes.size };
  }
  return { consumed: false, remaining: hashes.size };
}

export { generateToken };
