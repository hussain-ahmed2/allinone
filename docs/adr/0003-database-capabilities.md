# ADR-0003 — Database Capabilities (no forced relational semantics)

Every adapter declares an explicit capability matrix. Unsupported
operations MUST throw `UnsupportedCapabilityError` — a transaction that
cannot be provided is never simulated. Relational features (joins,
foreign keys, nested transactions, row-level security) are unavailable
on MongoDB/Redis and code must branch on `adapter.capabilities`, not on
assumed behaviour.

An adapter is "supported" only after `runAdapterConformance()`
(`@allinone/database`) passes, with documented exceptions for
capabilities it declares `false`.
