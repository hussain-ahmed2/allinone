/**
 * @allinone/cms — headless CMS primitives.
 *
 * Collections are defined with the typed field DSL from @allinone/database
 * and stored through a DatabaseAdapter — CMS stays database-agnostic.
 * Publishing statuses: draft → in-review → published → archived.
 */
import { defineCollection, fields, type CollectionDef, type InferModel } from "@allinone/database";

export type ContentStatus = "draft" | "in-review" | "published" | "archived";

export interface Revision {
  id: string;
  entryId: string;
  status: ContentStatus;
  snapshot: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
}

export interface ContentEntry {
  id: string;
  collection: string;
  status: ContentStatus;
  data: Record<string, unknown>;
  slug: string;
  locale: string;
  /** ISO timestamp for scheduled publishing (optional). */
  publishAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/**
 * Define a CMS collection.
 *
 * ```ts
 * const posts = defineCmsCollection("posts", {
 *   title: fields.string({ required: true }),
 *   slug: fields.string(),
 *   body: fields.string(),
 * });
 * ```
 */
export function defineCmsCollection<TFields extends Record<string, unknown>>(
  name: string,
  fieldsDef: TFields,
) {
  // Store as a database collection definition — validation lives at
  // the adapter/validation boundary, not in field type hacks.
  return defineCollection(
    name,
    fieldsDef as Parameters<typeof defineCollection>[1],
  ) as unknown as CollectionDef<TFields & Record<string, ReturnType<typeof fields.string>>>;
}

export type InferEntry<T> = InferModel<T>;

/** In-memory CMS store — swap for adapter-backed in production. */
export class CmsStore {
  readonly #entries = new Map<string, ContentEntry>();
  readonly #revisions: Revision[] = [];
  readonly #seq = (() => {
    let n = 0;
    return (): string => `ent_${(n += 1).toString(36)}`;
  })();

  create(input: {
    collection: string;
    data: Record<string, unknown>;
    slug: string;
    locale?: string;
    createdBy: string;
    publishAt?: string;
  }): ContentEntry {
    const now = new Date().toISOString();
    const entry: ContentEntry = {
      id: this.#seq(),
      collection: input.collection,
      status: "draft",
      data: { ...input.data },
      slug: input.slug,
      locale: input.locale ?? "en",
      ...(input.publishAt ? { publishAt: input.publishAt } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
    };
    this.#entries.set(entry.id, entry);
    this.#pushRevision(entry);
    return entry;
  }

  submitForReview(id: string): ContentEntry {
    return this.#transition(id, "draft", "in-review");
  }

  publish(id: string): ContentEntry {
    return this.#transition(id, "in-review", "published");
  }

  unpublish(id: string): ContentEntry {
    return this.#transition(id, "published", "archived");
  }

  update(id: string, patch: Record<string, unknown>): ContentEntry {
    const entry = this.#mustGet(id);
    const next: ContentEntry = {
      ...entry,
      data: { ...entry.data, ...patch },
      updatedAt: new Date().toISOString(),
    };
    this.#entries.set(id, next);
    this.#pushRevision(next);
    return next;
  }

  findByCollection(collection: string, status?: ContentStatus): ContentEntry[] {
    return [...this.#entries.values()].filter(
      (e) => e.collection === collection && (status === undefined || e.status === status),
    );
  }

  revisionsFor(entryId: string): Revision[] {
    return this.#revisions.filter((r) => r.entryId === entryId);
  }

  restoreRevision(entryId: string, revisionId: string): ContentEntry {
    const revision = this.#revisions.find((r) => r.id === revisionId);
    if (!revision || revision.entryId !== entryId) {
      throw new Error("[allinone/cms] Revision not found for entry");
    }
    return this.update(entryId, revision.snapshot);
  }

  #transition(id: string, from: ContentStatus, to: ContentStatus): ContentEntry {
    const entry = this.#mustGet(id);
    if (entry.status !== from) {
      throw new Error(
        `[allinone/cms] Invalid transition ${entry.status} → ${to} (expected ${from})`,
      );
    }
    const next: ContentEntry = {
      ...entry,
      status: to,
      updatedAt: new Date().toISOString(),
    };
    this.#entries.set(id, next);
    this.#pushRevision(next);
    return next;
  }

  #pushRevision(entry: ContentEntry): void {
    this.#revisions.push({
      id: `rev_${this.#revisions.length.toString(36)}_${entry.id}`,
      entryId: entry.id,
      status: entry.status,
      snapshot: { ...entry.data },
      createdAt: new Date().toISOString(),
      createdBy: entry.createdBy,
    });
  }

  #mustGet(id: string): ContentEntry {
    const e = this.#entries.get(id);
    if (!e) throw new Error(`[allinone/cms] Entry not found: ${id}`);
    return e;
  }
}

/** Slugify helper for SEO-friendly content URLs. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("[allinone/cms] Could not generate slug from input");
  return slug;
}
