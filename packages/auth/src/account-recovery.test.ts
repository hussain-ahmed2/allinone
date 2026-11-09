import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.js";

describe("email verification", () => {
  it("verifies emails single-use", async () => {
    const auth = new AuthService();
    const user = await auth.register({
      email: "verify@example.com",
      password: "correct horse battery",
      name: "Ver",
    });
    expect(user.emailVerified).toBe(false);
    const { token } = auth.requestEmailVerification(user.id);
    const verified = await auth.verifyEmail(token);
    expect(verified.emailVerified).toBe(true);
    // Single-use: second consume fails.
    await expect(auth.verifyEmail(token)).rejects.toThrow(/Invalid verification token/);
  });

  it("rejects unknown verification tokens", async () => {
    const auth = new AuthService();
    await expect(auth.verifyEmail("no-such-token")).rejects.toThrow(/Invalid verification token/);
  });
});

describe("password reset", () => {
  it("resets passwords, revokes sessions, and is single-use", async () => {
    const auth = new AuthService();
    const user = await auth.register({
      email: "reset@example.com",
      password: "correct horse battery",
      name: "Re",
    });
    const { session, refreshToken } = await auth.login({
      email: "reset@example.com",
      password: "correct horse battery",
      tenantId: "t1",
    });

    const issued = auth.requestPasswordReset("reset@example.com");
    expect(issued).not.toBeNull();
    const resetUser = await auth.consumePasswordReset(issued!.token, "new horse battery phrase");
    expect(resetUser.id).toBe(user.id);

    // Sessions from before the reset are revoked (refresh no longer works).
    await expect(auth.rotateRefresh(refreshToken)).rejects.toThrow(
      /Session revoked|Invalid refresh/,
    );

    // Old password rejected, new password accepted.
    await expect(
      auth.login({ email: "reset@example.com", password: "correct horse battery", tenantId: "t1" }),
    ).rejects.toThrow(/Invalid credentials/);
    await auth.login({
      email: "reset@example.com",
      password: "new horse battery phrase",
      tenantId: "t1",
    });

    // Token is single-use.
    await expect(auth.consumePasswordReset(issued!.token, "another horse battery")).rejects.toThrow(
      /Invalid reset token/,
    );
  });

  it("does not enumerate accounts", () => {
    const auth = new AuthService();
    expect(auth.requestPasswordReset("ghost@example.com")).toBeNull();
  });

  it("rotates tokens: only the latest reset token works", async () => {
    const auth = new AuthService();
    await auth.register({
      email: "rot@example.com",
      password: "correct horse battery",
      name: "Rot",
    });
    const first = auth.requestPasswordReset("rot@example.com");
    const second = auth.requestPasswordReset("rot@example.com");
    await expect(
      auth.consumePasswordReset(first!.token, "correct horse battery 2"),
    ).rejects.toThrow(/Invalid reset token/);
    await auth.consumePasswordReset(second!.token, "correct horse battery 2");
  });

  it("rejects weak replacement passwords", async () => {
    const auth = new AuthService();
    await auth.register({
      email: "weak@example.com",
      password: "correct horse battery",
      name: "W",
    });
    const issued = auth.requestPasswordReset("weak@example.com");
    await expect(auth.consumePasswordReset(issued!.token, "short")).rejects.toThrow(
      /12 characters/,
    );
  });
});

describe("changePassword + suspension", () => {
  it("changePassword verifies the current password and revokes sessions", async () => {
    const auth = new AuthService();
    const user = await auth.register({
      email: "chg@example.com",
      password: "correct horse battery",
      name: "Chg",
    });
    await expect(auth.changePassword(user.id, "wrong", "new horse battery phrase")).rejects.toThrow(
      /Invalid credentials/,
    );
    await auth.changePassword(user.id, "correct horse battery", "new horse battery phrase");
    await auth.login({
      email: "chg@example.com",
      password: "new horse battery phrase",
      tenantId: "t1",
    });
  });

  it("suspension blocks login and revokes sessions", async () => {
    const auth = new AuthService();
    const user = await auth.register({
      email: "sus@example.com",
      password: "correct horse battery",
      name: "Sus",
    });
    auth.setSuspended(user.id, true);
    await expect(
      auth.login({ email: "sus@example.com", password: "correct horse battery", tenantId: "t1" }),
    ).rejects.toThrow(/Invalid credentials/);
    expect(auth.requestPasswordReset("sus@example.com")).toBeNull();
    auth.setSuspended(user.id, false);
    await auth.login({
      email: "sus@example.com",
      password: "correct horse battery",
      tenantId: "t1",
    });
  });
});
