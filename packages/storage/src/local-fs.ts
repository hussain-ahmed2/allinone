/**
 * Local filesystem storage provider (zero dependencies).
 *
 * Files are written under a configurable root directory. Keys are resolved
 * through `assertObjectKey` + `realpath` containment — a traversal attempt
 * (`../secret`, absolute paths) is rejected even if a caller passes it.
 *
 * `getSignedUrl` returns a short-lived ticket URL for the framework's
 * file-serving route (`/files/:token`) — the caller maps tokens to keys.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  assertObjectKey,
  checkPut,
  type FileValidationRules,
  type StorageProvider,
} from "./validation.js";

export interface LocalFileOptions {
  /** Absolute storage root (required — no implicit tmp dirs). */
  root: string;
  /** Optional validation rules (extend/override defaults). */
  validation?: FileValidationRules;
  /** Base URL the framework serves files from (default "/files"). */
  baseUrl?: string;
  /** Signed-URL TTL seconds (default 900 = 15 minutes). */
  signedUrlTtlSeconds?: number;
}

interface Ticket {
  key: string;
  expiresAt: number;
}

export class LocalFileStorageProvider implements StorageProvider {
  readonly name = "local-fs";
  readonly #root: string;
  readonly #validation: FileValidationRules | undefined;
  readonly #baseUrl: string;
  readonly #ttl: number;
  readonly #tickets = new Map<string, Ticket>();

  constructor(options: LocalFileOptions) {
    if (!options.root) {
      throw new Error("[allinone/storage] LocalFileOptions.root is required");
    }
    this.#root = resolve(options.root);
    if (options.validation) this.#validation = options.validation;
    this.#baseUrl = options.baseUrl ?? "/files";
    this.#ttl = options.signedUrlTtlSeconds ?? 900;
  }

  /** Resolve a key to a filesystem path (throws on traversal). */
  private resolveKey(key: string): string {
    const safe = assertObjectKey(key);
    const target = resolve(this.#root, safe);
    // Defense in depth: the resolved path must stay under the root.
    if (target !== this.#root && !target.startsWith(this.#root + sep)) {
      throw new Error(`[allinone/storage] Path traversal blocked: ${JSON.stringify(key)}`);
    }
    return target;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<{ url: string }> {
    checkPut(key, data, contentType, this.#validation);
    const target = this.resolveKey(key);
    await mkdir(target.split(sep).slice(0, -1).join(sep) || this.#root, { recursive: true });
    await writeFile(target, data);
    return { url: `${this.#baseUrl}/${key}` };
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    assertObjectKey(key);
    const token = randomBytes(24).toString("base64url");
    const ttl = expiresInSeconds ?? this.#ttl;
    this.#tickets.set(token, { key, expiresAt: Date.now() + ttl * 1000 });
    return `${this.#baseUrl}/token/${token}`;
  }

  /** Resolve a signed URL token (framework calls this when serving). */
  resolveTicket(token: string): string {
    const ticket = this.#tickets.get(token);
    this.#tickets.delete(token); // single-use
    if (!ticket) throw new Error("[allinone/storage] Invalid or consumed signed URL");
    if (Date.now() > ticket.expiresAt) {
      throw new Error("[allinone/storage] Signed URL expired");
    }
    return this.resolveKey(ticket.key);
  }

  async delete(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) return false;
      await rm(target);
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolveKey(key);
    try {
      return (await stat(target)).isFile();
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    const target = this.resolveKey(key);
    try {
      return await readFile(target);
    } catch {
      return null;
    }
  }

  /** Storage root — framework maps tokens → paths; keep this private in prod. */
  get root(): string {
    return this.#root;
  }

  /** Stable content identity (SHA-256) — dedupe helper. */
  static hash(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }
}

export function createLocalFileProvider(options: LocalFileOptions): LocalFileStorageProvider {
  return new LocalFileStorageProvider(options);
}
