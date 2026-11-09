import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.js";
import { base32Decode, totpCode } from "./totp.js";

describe("Totp enrollment", () => {
  it("enrolls, verifies once, and rejects replays", async () => {
    const auth = new AuthService();
    const user = await auth.register({
      email: "mfa@example.com",
      password: "correct horse battery",
      name: "MFA",
    });
    expect(auth.isMfaEnabled(user.id)).toBe(false);

    const enrollment = auth.startTotpEnrollment(user.id, { issuer: "allinone" });
    expect(enrollment.secret).toBeTruthy();
    expect(enrollment.otpauthUri).toContain("otpauth://totp/allinone");
    expect(auth.isMfaEnabled(user.id)).toBe(false);

    const secret = base32Decode(enrollment.secret);
    const code = totpCode(secret);
    const confirmed = auth.confirmTotpEnrollment(user.id, code);
    expect(confirmed.recoveryCodes).toHaveLength(8);
    expect(auth.isMfaEnabled(user.id)).toBe(true);

    // The enrollment code itself is replay-protected.
    expect(auth.verifyTotp(user.id, code)).toBe(false);

    // Disable with a fresh next-step code (within the ±1 window, not consumed).
    auth.disableTotp(user.id, totpCode(secret, Date.now() + 30_000));
    expect(auth.isMfaEnabled(user.id)).toBe(false);
  });

  it("rejects bad enrollment + codes for unknown users", async () => {
    const auth = new AuthService();
    expect(() => auth.startTotpEnrollment("ghost", { issuer: "i" })).toThrow(/not found/);
    const user = await auth.register({
      email: "two@example.com",
      password: "correct horse battery",
      name: "Two",
    });
    auth.startTotpEnrollment(user.id, { issuer: "i" });
    expect(() => auth.confirmTotpEnrollment(user.id, "000000")).toThrow(/Invalid enrollment/);
  });

  it("recovery codes are single-use", async () => {
    const auth = new AuthService();
    const user = await auth.register({
      email: "rec@example.com",
      password: "correct horse battery",
      name: "Rec",
    });
    const enrollment = auth.startTotpEnrollment(user.id, { issuer: "i" });
    const { recoveryCodes } = auth.confirmTotpEnrollment(
      user.id,
      totpCode(base32Decode(enrollment.secret)),
    );
    expect(auth.useRecoveryCode(user.id, recoveryCodes[0]!)).toBe(true);
    expect(auth.useRecoveryCode(user.id, recoveryCodes[0]!)).toBe(false);
    expect(auth.useRecoveryCode(user.id, "NOPE-NOPE")).toBe(false);
  });
});

describe("external identity linking", () => {
  it("links verified emails and creates accounts on first sign-in", async () => {
    const auth = new AuthService();
    const first = await auth.linkExternalIdentity("google", {
      sub: "g-1",
      email: "ada@example.com",
      name: "Ada",
      emailVerified: true,
    });
    expect(first.created).toBe(true);
    const second = await auth.linkExternalIdentity("google", {
      sub: "g-1",
      email: "ada@example.com",
      emailVerified: true,
    });
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("rejects unverified or missing emails", async () => {
    const auth = new AuthService();
    await expect(
      auth.linkExternalIdentity("google", { sub: "g-2", email: "x@example.com" }),
    ).rejects.toThrow(/verified email/);
    await expect(auth.linkExternalIdentity("google", { sub: "g-3" })).rejects.toThrow(
      /verified email/,
    );
  });
});
