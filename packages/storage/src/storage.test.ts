import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileStorageProvider } from "./local-fs.js";
import { MediaLibrary } from "./media.js";

describe("LocalFileStorageProvider", () => {
  let root: string;
  let provider: LocalFileStorageProvider;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "allinone-storage-"));
    provider = new LocalFileStorageProvider({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads, reads, exists, and deletes", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const put = await provider.put("t1/x.png", png, "image/png");
    expect(put.url).toBe("/files/t1/x.png");
    expect(await provider.exists("t1/x.png")).toBe(true);
    expect(await provider.read("t1/x.png")).toEqual(png);
    expect(await provider.delete("t1/x.png")).toBe(true);
    expect(await provider.delete("t1/x.png")).toBe(false);
  });

  it("rejects traversal and magic spoofing", async () => {
    await expect(provider.put("../evil.txt", Buffer.from("x"), "text/plain")).rejects.toThrow(
      /traversal/,
    );
    await expect(
      provider.put("t1/x.png", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/png"),
    ).rejects.toThrow(/Magic bytes/);
  });

  it("issues single-use signed URLs", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    await provider.put("t1/x.png", png, "image/png");
    const url = await provider.getSignedUrl("t1/x.png", 60);
    expect(url).toContain("/files/token/");
    const token = url.split("/token/").pop() ?? "";
    expect(provider.resolveTicket(token)).toContain("x.png");
    // Single-use: second resolve fails.
    expect(() => provider.resolveTicket(token)).toThrow(/Invalid/);
  });
});

describe("MediaLibrary", () => {
  it("scopes items by tenant and tracks metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "allinone-media-"));
    try {
      const library = new MediaLibrary(new LocalFileStorageProvider({ root }));
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      const item = await library.upload({
        tenantId: "acme",
        folder: "avatars",
        filename: "me.png",
        data: png,
        contentType: "image/png",
        createdBy: "u1",
      });
      expect(item.tenantId).toBe("acme");
      expect(item.sizeBytes).toBe(png.length);
      expect(library.list("acme")).toHaveLength(1);
      expect(library.list("acme", "other")).toHaveLength(0);
      expect(library.list("other-tenant")).toHaveLength(0);
      const url = await library.signedUrl("acme", item.id);
      expect(url).toContain("/files/token/");
      // Cross-tenant signed URL is rejected.
      await expect(library.signedUrl("other-tenant", item.id)).rejects.toThrow(/not found/);
      await expect(library.remove("other-tenant", item.id)).resolves.toBe(false);
      await expect(library.remove("acme", item.id)).resolves.toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
