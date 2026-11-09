import { describe, expect, it } from "vitest";
import { assertObjectKey, contentHash, tenantKey, validateFile } from "./validation.js";

describe("assertObjectKey", () => {
  it("accepts safe keys", () => {
    expect(assertObjectKey("t1/my file.png")).toBe("t1/my file.png");
    expect(assertObjectKey("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("rejects traversal and absolute paths", () => {
    expect(() => assertObjectKey("../secret.txt")).toThrow(/traversal/);
    expect(() => assertObjectKey("/etc/passwd")).toThrow(/Invalid object key/);
    expect(() => assertObjectKey("a\\b.txt")).toThrow(/Invalid object key/);
    expect(() => assertObjectKey("a/../b")).toThrow(/traversal/);
    expect(() => assertObjectKey("")).toThrow(/Invalid object key/);
  });
});

describe("tenantKey", () => {
  it("namespaces keys per tenant", () => {
    expect(tenantKey("acme", "p.png")).toBe("acme/p.png");
    expect(() => tenantKey("a/b", "p.png")).toThrow(/Invalid tenant id/);
    expect(() => tenantKey("acme", "../x")).toThrow(/traversal/);
  });
});

describe("validateFile", () => {
  it("accepts matching magic bytes", () => {
    // Genuine PNG header bytes.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(() => {
      validateFile({ filename: "x.png", sizeBytes: png.length, data: png });
    }).not.toThrow();
  });

  it("rejects extension spoofing (magic mismatch)", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(() => {
      validateFile({ filename: "x.png", sizeBytes: jpeg.length, data: jpeg });
    }).toThrow(/Magic bytes/);
  });

  it("rejects oversized + disallowed files", () => {
    expect(() => {
      validateFile({ filename: "x.txt", sizeBytes: 11 * 1024 * 1024 });
    }).toThrow(/exceeds/);
    expect(() => {
      validateFile({ filename: "x.exe", sizeBytes: 10 });
    }).toThrow(/not allowed/);
    expect(() => {
      validateFile({ filename: "x", sizeBytes: 10 });
    }).toThrow(/not allowed/);
    expect(() => {
      validateFile({ filename: "x.txt", sizeBytes: 0 });
    }).toThrow(/Empty/);
  });
});

describe("contentHash", () => {
  it("is content-addressed", () => {
    expect(contentHash(Buffer.from("data"))).toBe(contentHash(Buffer.from("data")));
    expect(contentHash(Buffer.from("data"))).not.toBe(contentHash(Buffer.from("other")));
  });
});
