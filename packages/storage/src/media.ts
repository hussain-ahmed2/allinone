/**
 * MediaLibrary — tenant-aware media management over any StorageProvider.
 *
 * Files land at `{tenantId}/{folder}/{id}-{filename}`; an in-memory index
 * tracks metadata (size, content type, folder, owner) per tenant so list
 * and signed-URL flows stay tenant-scoped by construction.
 */
import { randomBytes } from "node:crypto";
import { contentHash, tenantKey, type StorageProvider } from "./validation.js";

export interface MediaItem {
  id: string;
  tenantId: string;
  folder: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  hash: string;
  key: string;
  createdAt: string;
  createdBy: string;
}

export class MediaLibrary {
  readonly #provider: StorageProvider;
  readonly #items = new Map<string, MediaItem>(); // global id -> item

  constructor(provider: StorageProvider) {
    this.#provider = provider;
  }

  async upload(input: {
    tenantId: string;
    folder?: string;
    filename: string;
    data: Buffer;
    contentType: string;
    createdBy: string;
  }): Promise<MediaItem> {
    const id = `med_${randomBytes(9).toString("base64url")}`;
    const folder = input.folder ?? "root";
    const key = tenantKey(input.tenantId, `${folder}/${id}-${input.filename}`);
    await this.#provider.put(key, input.data, input.contentType);
    const item: MediaItem = {
      id,
      tenantId: input.tenantId,
      folder,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      hash: contentHash(input.data),
      key,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    this.#items.set(id, item);
    return item;
  }

  /** Tenant-scoped list — cross-tenant items are invisible. */
  list(tenantId: string, folder?: string): MediaItem[] {
    return [...this.#items.values()].filter(
      (item) => item.tenantId === tenantId && (folder === undefined || item.folder === folder),
    );
  }

  async signedUrl(tenantId: string, itemId: string): Promise<string> {
    const item = this.#items.get(itemId);
    if (!item || item.tenantId !== tenantId) {
      throw new Error("[allinone/storage] Media item not found for tenant");
    }
    return this.#provider.getSignedUrl(item.key);
  }

  async remove(tenantId: string, itemId: string): Promise<boolean> {
    const item = this.#items.get(itemId);
    if (!item || item.tenantId !== tenantId) return false;
    const deleted = await this.#provider.delete(item.key);
    this.#items.delete(itemId);
    return deleted;
  }
}

export function createMediaLibrary(provider: StorageProvider): MediaLibrary {
  return new MediaLibrary(provider);
}
