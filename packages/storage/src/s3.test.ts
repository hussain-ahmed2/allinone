import { describe, expect, it } from "vitest";
import { S3StorageProvider, type S3Ops } from "./s3.js";

/** In-memory fake S3 — asserts calls without touching the network. */
function makeFake(): { ops: S3Ops; calls: string[] } {
  const calls: string[] = [];
  const store = new Map<string, Buffer>();
  const ops: S3Ops = {
    async putObject(input: { bucket: string; key: string; body: Buffer; contentType: string }) {
      store.set(`${input.bucket}/${input.key}`, input.body);
      calls.push(`put:${input.bucket}/${input.key}`);
    },
    async deleteObject(input: { bucket: string; key: string }) {
      store.delete(`${input.bucket}/${input.key}`);
      calls.push(`del:${input.bucket}/${input.key}`);
    },
    async headExists(input: { bucket: string; key: string }): Promise<boolean> {
      return store.has(`${input.bucket}/${input.key}`);
    },
    async presignGet(input: { bucket: string; key: string; expiresIn: number }): Promise<string> {
      return `https://presigned.example/${input.bucket}/${input.key}?expires=${String(input.expiresIn)}`;
    },
  };
  return { ops, calls };
}

describe("S3StorageProvider", () => {
  it("puts, exists, signs, and deletes against the ops layer", async () => {
    const { ops, calls } = makeFake();
    const provider = new S3StorageProvider({ bucket: "media", ops });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const put = await provider.put("t1/x.png", png, "image/png");
    expect(put.url).toContain("media.s3.amazonaws.com");
    expect(calls).toContain("put:media/t1/x.png");
    expect(await provider.exists("t1/x.png")).toBe(true);
    const url = await provider.getSignedUrl("t1/x.png", 60);
    expect(url).toContain("expires=60");
    expect(await provider.delete("t1/x.png")).toBe(true);
    expect(await provider.delete("t1/x.png")).toBe(false);
  });

  it("validates before touching S3", async () => {
    const { ops } = makeFake();
    const provider = new S3StorageProvider({ bucket: "media", ops });
    await expect(provider.put("../evil.txt", Buffer.from("x"), "text/plain")).rejects.toThrow(
      /traversal/,
    );
    await expect(
      provider.put("t1/x.png", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/png"),
    ).rejects.toThrow(/Magic bytes/);
  });

  it("honors custom validation rules", async () => {
    const { ops } = makeFake();
    const provider = new S3StorageProvider({
      bucket: "media",
      ops,
      validation: { maxBytes: 8, allowedExtensions: ["txt"] },
    });
    await expect(provider.put("t1/x.txt", Buffer.from("123456789"), "text/plain")).rejects.toThrow(
      /exceeds/,
    );
  });
});
