import { describe, expect, it } from "vitest";
import { compose, presets } from "./index.js";

describe("presets", () => {
  it("starter is single-tenant with auth", () => {
    const p = presets.starter();
    expect(p.auth?.enabled).toBe(true);
    expect(p.cms?.enabled).toBe(false);
    expect(p.modules?.admin).toBe(true);
  });

  it("saas enables tenancy, billing, api keys", () => {
    const p = presets.saas();
    expect(p.tenancy?.strategy).toBeDefined();
    expect(p.modules?.billing).toBe(true);
    expect(p.modules?.apiKeys).toBe(true);
  });

  it("enterprise enables workflows + long audit retention", () => {
    const p = presets.enterprise();
    expect(p.modules?.workflows).toBe(true);
    expect(p.audit?.retentionDays).toBe(365);
  });

  it("cms preset enables CMS + localization", () => {
    const p = presets.cms();
    expect(p.cms?.enabled).toBe(true);
    expect(p.cms?.localization).toBe(true);
  });

  it("presets compose — later wins per-section", () => {
    const p = compose(presets.saas(), presets.cms());
    expect(p.cms?.enabled).toBe(true); // from cms preset
    expect(p.modules?.billing).toBe(true); // from saas preset
  });
});
