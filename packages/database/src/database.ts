/**
 * @allinone/database — database-agnostic data layer.
 *
 * Design rules (see docs/adr/0003-database-capabilities.md):
 *  - Every adapter declares explicit `capabilities` — unsupported features
 *    throw `UnsupportedCapabilityError`, never silently simulated.
 *  - Relational semantics are NOT forced onto MongoDB / Redis.
 *  - All queries are parameterized by construction — no string
 *    interpolation of values into queries.
 *
 * The `memory` adapter ships in-repo (tests + examples); PostgreSQL
 * (`@allinone/database-postgres`, live PG17 tested) and MongoDB
 * (`@allinone/database-mongodb`, local mongod tested) ship as separate
 * packages. Other adapters (MySQL / ...) ship as separate,
 * conformance-tested packages — do not claim support until
 * `runAdapterConformance()` passes.
 */

/** Explicit capability matrix — every adapter must declare this truthfully. */
export interface DatabaseCapabilities {
  transactions: boolean;
  nestedTransactions: boolean;
  foreignKeys: boolean;
  joins: boolean;
  jsonQueries: boolean;
  fullTextSearch: boolean;
  schemaMigrations: boolean;
  optimisticLocking: boolean;
  rowLevelSecurity: boolean;
  softDeletes: boolean;
}

/** Minimal row type — JSON-serializable document/row. */
export type Row = Record<string, unknown>;

/** Filter operators (safe, parameterized — validated before use). */
export type FilterOperator =
  "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "nin" | "contains" | "isNull" | "isNotNull";

export interface Filter {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface QueryOptions {
  filters?: readonly Filter[];
  sort?: readonly { field: string; direction: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  /** Tenant scoping — adapters MUST enforce when tenancy is enabled. */
  tenantId?: string;
}

export interface AdapterContext {
  tenantId?: string;
  requestId?: string;
}

export interface DatabaseAdapter {
  readonly name: string;
  readonly capabilities: DatabaseCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
  createTable?(collection: string): Promise<void>;
  insert(collection: string, rows: readonly Row[], ctx?: AdapterContext): Promise<Row[]>;
  find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]>;
  update(collection: string, id: string, patch: Row, ctx?: AdapterContext): Promise<Row | null>;
  remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean>;
  transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;
  /**
   * Run pending migrations. No-op when capability is false.
   * Adapters define their own migration shape (e.g. Postgres takes
   * `readonly Migration[]`); it is intentionally `unknown[]` here so
   * adapters are not forced into one migration type.
   */
  migrate?(migrations?: readonly unknown[]): Promise<void>;
}

export class UnsupportedCapabilityError extends Error {
  readonly capability: string;
  constructor(capability: string, adapter: string) {
    super(
      `[allinone/database] Adapter "${adapter}" does not support "${capability}". ` +
        `This operation was not simulated — it is unavailable on this backend.`,
    );
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
  }
}

export function assertCapability(
  adapter: DatabaseAdapter,
  capability: keyof DatabaseCapabilities,
): void {
  if (!adapter.capabilities[capability]) {
    throw new UnsupportedCapabilityError(capability, adapter.name);
  }
}

/* ------------------------------------------------------------------ */
/* Typed schema builder                                                 */
/* ------------------------------------------------------------------ */

/** Field kinds supported by the schema builder. */
export type FieldKind =
  | "uuid"
  | "string"
  | "email"
  | "number"
  | "boolean"
  | "enum"
  | "datetime"
  | "createdAt"
  | "updatedAt"
  | "json";

export interface FieldDef<TKind extends FieldKind = FieldKind> {
  readonly kind: TKind;
  readonly required: boolean;
  readonly unique: boolean;
  readonly defaultValue?: unknown;
  readonly enumValues?: readonly string[];
}

type InferField<T> =
  T extends FieldDef<"uuid">
    ? string
    : T extends FieldDef<"string">
      ? string
      : T extends FieldDef<"email">
        ? string
        : T extends FieldDef<"number">
          ? number
          : T extends FieldDef<"boolean">
            ? boolean
            : T extends FieldDef<"enum">
              ? string
              : T extends FieldDef<"datetime"> | FieldDef<"createdAt"> | FieldDef<"updatedAt">
                ? string
                : T extends FieldDef<"json">
                  ? unknown
                  : never;

export interface CollectionDef<TFields extends Record<string, FieldDef>> {
  readonly name: string;
  readonly fields: TFields;
}

/** Create a typed collection definition. */
export function defineCollection<TFields extends Record<string, FieldDef>>(
  name: string,
  fields: TFields,
): CollectionDef<TFields> {
  return { name, fields };
}

/** Infer row type from a collection definition. */
export type InferModel<T> =
  T extends CollectionDef<infer F> ? { [K in keyof F]: InferField<F[K]> } : never;

/**
 * Field factory — mirrors the requested API:
 *   fields.uuid() / fields.string({ required: true }) / fields.email({ unique: true })
 */
export const fields = {
  uuid: (): FieldDef<"uuid"> => ({ kind: "uuid", required: true, unique: true }),
  string: (
    opts: { required?: boolean; unique?: boolean; defaultValue?: string } = {},
  ): FieldDef<"string"> => ({
    kind: "string",
    required: opts.required ?? true,
    unique: opts.unique ?? false,
    ...(opts.defaultValue !== undefined ? { defaultValue: opts.defaultValue } : {}),
  }),
  email: (opts: { required?: boolean; unique?: boolean } = {}): FieldDef<"email"> => ({
    kind: "email",
    required: opts.required ?? true,
    unique: opts.unique ?? true,
  }),
  number: (opts: { required?: boolean } = {}): FieldDef<"number"> => ({
    kind: "number",
    required: opts.required ?? true,
    unique: false,
  }),
  boolean: (opts: { required?: boolean } = {}): FieldDef<"boolean"> => ({
    kind: "boolean",
    required: opts.required ?? true,
    unique: false,
  }),
  enum: (values: readonly string[], opts: { required?: boolean } = {}): FieldDef<"enum"> => ({
    kind: "enum",
    required: opts.required ?? true,
    unique: false,
    enumValues: values,
  }),
  datetime: (): FieldDef<"datetime"> => ({
    kind: "datetime",
    required: true,
    unique: false,
  }),
  createdAt: (): FieldDef<"createdAt"> => ({
    kind: "createdAt",
    required: true,
    unique: false,
  }),
  updatedAt: (): FieldDef<"updatedAt"> => ({
    kind: "updatedAt",
    required: true,
    unique: false,
  }),
  json: (): FieldDef<"json"> => ({ kind: "json", required: false, unique: false }),
};
