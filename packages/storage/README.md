# @allinone/storage

Storage providers for `allinone` — local filesystem + S3-compatible,
with upload validation and tenant-aware media management.

## Install

```bash
pnpm add @allinone/storage
```

## Usage

```ts
import { createLocalFileProvider, createS3Provider, createMediaLibrary } from "@allinone/storage";

// Local filesystem (zero native deps)
const files = createLocalFileProvider({ root: "./data/uploads" });
await files.put("t1/avatar.png", pngBuffer, "image/png");
const url = await files.getSignedUrl("t1/avatar.png", 60);

// S3-compatible (AWS, MinIO, R2, Spaces — SDK SigV4 signing)
const s3 = createS3Provider({
  bucket: "media",
  endpoint: "https://minio.example.com",
  credentials: { accessKeyId, secretAccessKey },
});

// Tenant-aware media library over either provider
const library = createMediaLibrary(files);
const item = await library.upload({
  tenantId: "acme",
  folder: "avatars",
  filename: "me.png",
  data: pngBuffer,
  contentType: "image/png",
  createdBy: userId,
});
const url = await library.signedUrl("acme", item.id);
```

## Security

- Keys rejecting traversal (`..`, absolute paths, backslashes).
- Validation (size + extension allowlist + **magic-byte sniffing** for
  images/PDFs) runs before the write. Signed URL tokens are single-use
  with real expiry (local) or SigV4 presigners (S3).

## Testing

```bash
pnpm --filter @allinone/storage test
```
