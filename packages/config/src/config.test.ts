import { describe, expect, it } from "vitest";
import {
  assertSecure,
  platformDefaults,
  resolveConfig,
  type ResolvedPlatformConfig,
} from "./config.js";

describe("resolveConfig", () => {
  it("fills secure defaults", () => {
    const cfg = resolveConfig({ database: { adapter: "memory" } });
    expect(cfg.authorization.defaultDeny).toBe(true);
    expect(cfg.auth.session.httpOnly).toBe(true);
    expect(cfg.auth.session.secure).toBe(true);
    expect(cfg.auth.session.rotateRefreshTokens).toBe(true);
    expect(cfg.tenancy.enforceIsolation).toBe(true);
  });

  it("merges preset then user override without wiping sections", () => {
    const cfg = resolveConfig({
      preset: {
        auth: { mfa: true },
        modules: { billing: true },
      },
      database: { adapter: "memory" },
      auth: { enabled: true },
    });
    expect(cfg.auth.mfa).toBe(true);
    expect(cfg.auth.enabled).toBe(true);
    expect(cfg.modules.billing).toBe(true);
  });

  it("rejects disabling default-deny", () => {
    expect(() =>
      resolveConfig({
        database: { adapter: "memory" },
        authorization: { defaultDeny: false },
      }),
    ).toThrow(/defaultDeny/);
  });

  it("rejects insecure cookies without explicit opt-in", () => {
    expect(() =>
      resolveConfig({
        database: { adapter: "memory" },
        auth: { session: { httpOnly: false } as never },
      }),
    ).toThrow(/httpOnly/);
  });

  it("allows insecure cookies only with dangerouslyAllowInsecure", () => {
    const cfg = resolveConfig({
      database: { adapter: "memory" },
      auth: { session: { httpOnly: false } as never },
      dangerouslyAllowInsecure: true,
    });
    expect(cfg.auth.session.httpOnly).toBe(false);
  });
});

describe("assertSecure", () => {
  it("throws on isolation disabled even when allowInsecure=true", () => {
    const cfg: ResolvedPlatformConfig = {
      ...platformDefaults,
      tenancy: { ...platformDefaults.tenancy, enforceIsolation: false },
    };
    expect(() => { assertSecure(cfg, true); }).toThrow(/enforceIsolation/);
  });
});
