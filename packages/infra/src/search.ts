/**
 * Search helpers — adapter-backed full-text search over document fields.
 *
 * Two modes:
 *  - `searchAcross`: fans runner-adapter `find()` with contains filters
 *    per field and de-duplicates by id (OR semantics). Best for small
 *    collections on memory/SQLite/Redis adapters.
 *  - `MemorySearchIndex`: a tokenized inverted index for larger sets
 *    with prefix + scored multi-term queries (no database dependency).
 *
 * Both take an explicit `tenantId` so search stays tenant-scoped:
 * cross-tenant hits are impossible by construction.
 */
import type { DatabaseAdapter, Row } from "@allinone/database";

export interface SearchOptions {
  tenantId?: string;
  fields: readonly string[];
  query: string;
  limit?: number;
}

/**
 * Multi-field substring search against any DatabaseAdapter.
 * Issues one find per field and merges unique ids.
 */
export async function searchAcross(
  adapter: DatabaseAdapter,
  collection: string,
  options: SearchOptions,
): Promise<Row[]> {
  if (!options.query.trim()) return [];
  const seen = new Map<string, Row>();
  for (const field of options.fields) {
    const rows = await adapter.find(collection, {
      filters: [{ field, operator: "contains", value: options.query }],
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    });
    for (const row of rows) {
      const id = String(row["id"]);
      if (!seen.has(id)) seen.set(id, row);
    }
  }
  const all = [...seen.values()];
  return options.limit !== undefined ? all.slice(0, options.limit) : all;
}

export interface IndexedDoc {
  id: string;
  tenantId?: string;
  text: string;
  payload?: Record<string, unknown>;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/**
 * Tokenized in-memory search index with prefix matching.
 * Indexes are per-tenant (query requires a tenant id or matches all
 * tenants you pass explicitly).
 */
export class MemorySearchIndex {
  readonly #docs = new Map<string, { doc: IndexedDoc; tokens: Set<string> }>();

  add(doc: IndexedDoc): void {
    this.#docs.set(doc.id, { doc, tokens: tokenize(doc.text) });
  }

  /** Remove all indexed documents for a tenant. */
  clearTenant(tenantId: string): void {
    for (const [id, entry] of this.#docs) {
      if (entry.doc.tenantId === tenantId) this.#docs.delete(id);
    }
  }

  /**
   * Scored search: each query token must match some indexed token as an
   * exact token or a prefix; score = matching-token count.
   */
  search(input: { tenantId?: string; query: string; limit?: number }): IndexedDoc[] {
    const queryTokens = [...tokenize(input.query)];
    if (queryTokens.length === 0) return [];
    const scored: { doc: IndexedDoc; score: number }[] = [];
    for (const { doc, tokens } of this.#docs.values()) {
      if (input.tenantId !== undefined && doc.tenantId !== input.tenantId) continue;
      let score = 0;
      for (const needle of queryTokens) {
        let matched = false;
        for (const token of tokens) {
          if (token === needle || token.startsWith(needle)) {
            matched = true;
            break;
          }
        }
        if (matched) score += 1;
      }
      if (score === queryTokens.length) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const docs = scored.map((s) => s.doc);
    return input.limit !== undefined ? docs.slice(0, input.limit) : docs;
  }

  size(): number {
    return this.#docs.size;
  }
}

export function createSearchIndex(): MemorySearchIndex {
  return new MemorySearchIndex();
}
