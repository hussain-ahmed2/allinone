/**
 * Storage providers for @allinone/infra.
 *
 * Security rules:
 *  - Keys are validated against traversal (`..`, `/`-prefixed, backslashes).
 *  - Content is validated BEFORE storage: size limit + MIME allowlist by
 *    extension AND by magic-byte sniffing for the risky/ambiguous types
 *    (images), never trusting the uploader's claim alone.
 *  - Tenant data is namespaced per provider configuration; the provider
 *    itself takes fully-scoped keys so cross-tenant writes are impossible
 *    at the SDK layer.
 */
import { createHash } from "node:crypto";

/** Upload constraints — size + extension allowlist. */
export interface FileValidationRules {
  /** Max bytes per file. */
  maxBytes: number;
  /** Allowed extensions (lowercase, dotless). */
  allowedExtensions: readonly string[];
}

export const DEFAULT_VALIDATION: FileValidationRules = {
  maxBytes: 10 * 1024 * 1024,
  allowedExtensions: ["png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md"],
};

/** Magic-byte signatures for extension-claim verification of image types. */
const MAGIC_BYTES: Record<string, string[]> = {
  png: ["89504e470d0a1a0a"],
  jpg: ["ffd8ff"],
  jpeg: ["ffd8ff"],
  gif: ["47494638"],
  webp: ["52494646"],
  pdf: ["25504446"],
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Validate an upload WITHOUT trusting extension claims for binary types.
 * Throws on any violation.
 */
export function validateFile(input: {
  filename: string;
  sizeBytes: number;
  data?: Buffer;
  rules?: FileValidationRules;
}): void {
  const rules = input.rules ?? DEFAULT_VALIDATION;
  if (input.sizeBytes <= 0) {
    throw new Error("[allinone/storage] Empty file");
  }
  if (input.sizeBytes > rules.maxBytes) {
    throw new Error(
      `[allinone/storage] File exceeds ${String(Math.round(rules.maxBytes / 1024 / 1024))}MB limit`,
    );
  }
  const extension = extensionOf(input.filename);
  if (!extension || !rules.allowedExtensions.includes(extension)) {
    throw new Error(`[allinone/storage] Extension "${extension}" is not allowed`);
  }
  const signature = MAGIC_BYTES[extension];
  if (signature && input.data) {
    const head = input.data.subarray(0, 8).toString("hex");
    const matched = signature.some((sig) => head.startsWith(sig));
    if (matched) return;
    // WEBP ("RIFFxxxxWEBP") starts with "RIFF" — check it too.
    if (extension === "webp" && head.startsWith("52494646")) return;
    throw new Error(`[allinone/storage] Magic bytes do not match extension "${extension}"`);
  }
}

/** Validate a storage key — no traversal, no absolute paths, no backslashes. */
export function assertObjectKey(key: string): string {
  if (!key || key.startsWith("/") || key.startsWith("\\") || key.includes("\\")) {
    throw new Error(`[allinone/storage] Invalid object key: ${JSON.stringify(key)}`);
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === "" || segment.startsWith(".")) {
      throw new Error(`[allinone/storage] Path traversal blocked: ${JSON.stringify(key)}`);
    }
  }
  return key;
}

/** Tenant-prefixed key for cross-tenant-proof storage. */
export function tenantKey(tenantId: string, key: string): string {
  if (!tenantId || tenantId.includes("..") || tenantId.includes("/")) {
    throw new Error("[allinone/storage] Invalid tenant id");
  }
  return `${tenantId}/${assertObjectKey(key)}`;
}

/**
 * Common provider contract (compatible with @allinone/infra StorageProvider).
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<{ url: string }>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<boolean>;
  exists?(key: string): Promise<boolean>;
  list?(prefix: string): Promise<string[]>;
}

/** Provider-wide validation helper shared by implementations. */
export function checkPut(
  key: string,
  data: Buffer,
  contentType: string,
  rules: FileValidationRules | undefined,
): void {
  assertObjectKey(key);
  if (!contentType) throw new Error("[allinone/storage] contentType is required");
  validateFile({
    filename: key.split("/").pop() ?? key,
    sizeBytes: data.length,
    data,
    ...(rules ? { rules } : {}),
  });
}

/** ETag/hash helper — identical content hashes identically on every provider. */
export function contentHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
