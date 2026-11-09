# API Reference

Public API by package. Error behavior + security notes follow each section.
See `docs/DEPLOYMENT.md` for operations; `docs/TROUBLESHOOTING.md` for
field fixes.

## `allinone` (platform)

```ts
createPlatform(options: PlatformOptions): Platform
platform.initialize(): Promise<void>   // connect + module init
platform.shutdown(): Promise<void>
platform.extend(module: PlatformModule): Platform
platform.extendMany(modules: readonly PlatformModule[]): Platform
platform.database / .tenants / .tenantContext / .auth / .cms / .audit
  / .apiKeys / .cache / .subscriptions / .rateLimiter
platform.config: ResolvedPlatformConfig
platform.container: Container            // register<T>(token, value), resolve<T>(token)
platform.lifecycle.{onRequest, onResponse, onError}: hooks
platform.isModuleEnabled(name): boolean
```

**Errors:** `PlatformError` (stable `.code`); unknown DB adapter →
`DATABASE_ADAPTER_UNAVAILABLE`. Duplicate module name → `DUPLICATE_MODULE`.
**Security:** init is idempotent; partial-init failures leave `isInitialized`
false — never half-serving.

## `@allinone/config`

```ts
resolveConfig(options: PlatformOptions): ResolvedPlatformConfig
assertSecure(config, allowInsecure): void   // security invariants (throws)
platformDefaults
```

**Errors:** violations throw with `[allinone] Security invariant: …`.
**Security:** default-deny + tenant isolation can NEVER be disabled; cookie
weakening requires `dangerouslyAllowInsecure: true`.

## `@allinone/database`

```ts
fields.uuid() / .string() / .email() / .number() / .boolean() / .enum(values)
  / .datetime() / .createdAt() / .updatedAt() / .json()
defineCollection(name, fields): CollectionDef
type InferModel<T>
assertCapability(adapter, capability): void
class UnsupportedCapabilityError
```

**Errors:** `UnsupportedCapabilityError` when a capability is false — never a
silent fallback. `assertCapability` is the enforcement point.

## `@allinone/database-postgres` / `@allinone/database-mongodb`

`createPostgresAdapter({ connectionString, pool, queryable, max, schemaProvider })`,
`createMongoAdapter({ connectionString, dbName, dbProvider, client })`.

Standard `DatabaseAdapter` methods plus adapter extras:
Postgres — `query(text, params)` (parameterized escape hatch),
`updateOptimistic`, `hardRemove`, `migrate`, `createTenantSchema`,
`enableTenantRowLevelSecurity`, `withTenantSetting`.
Mongo — `aggregate`, `updateOptimistic`, `hardRemove`, `migrate`,
`createTenantDatabase`.

**Errors:** bad identifiers (SQL injection guard), NoSQL object values
(`{ $gt: "" }`) rejected locally, `No database/schema for tenant` when
providers lack a mapping. **Security:** all values bound as parameters;
Mongo rejects objects-as-values.

## `@allinone/tenancy`

```ts
new TenantContext()              // runWithTenant(id, fn), getCurrent(), require()
new TenantRegistry()             // create/get/list/suspend/activate/archive/resolveByDomain
createHeaderResolver(registry, isMember): TenantResolver
tenantCacheKey(tenantId, key): string
```

**Errors:** `require()` without context throws `[allinone/tenancy] No active
tenant context`. Header resolver returns `null` unless membership validates —
a raw tenant ID from a client is never trusted.

## `@allinone/auth`

```ts
new AuthService({ hasher, maxLoginAttempts, lockoutSeconds, sessionMaxAgeSeconds })
auth.register({ email, password, name }): Promise<User>
auth.login({ email, password, tenantId }): Promise<{ session, refreshToken }>
auth.rotateRefresh(refreshToken): Promise<{ session, refreshToken }>
auth.logout(sessionId)
auth.requestEmailVerification(userId): { token, expiresAt }       // email/token flows
auth.verifyEmail(token): Promise<User>                             // single-use, 24h
auth.requestPasswordReset(email): { token, expiresAt } | null      // null → generic response
auth.consumePasswordReset(token, newPassword): Promise<User>       // single-use; revokes sessions
auth.changePassword(userId, current, next): Promise<void>          // audit-friendly
auth.setSuspended(userId, boolean)
auth.startTotpEnrollment(userId, { issuer }): { secret, otpauthUri }
auth.confirmTotpEnrollment(userId, code): { recoveryCodes }
auth.verifyTotp(userId, code): boolean          // replay-protected
auth.disableTotp(userId, code): void
auth.useRecoveryCode(userId, code): boolean      // single-use
auth.linkExternalIdentity(providerId, oidcUser): Promise<{ user, created }>
scryptHasher(), generateToken(), hashToken()
evaluatePolicy(query, roles, policies?): PolicyDecision   // default-deny
can(query, roles, policies?): boolean
effectivePermissions(roleId, rolesById): string[]
createPermissionCache({ cache, ttlSeconds }): PermissionCache
  .can(query, roles, tenantId, policies?): Promise<boolean>  // versioned keys + invalidation
  .invalidateActor(actorId) / .invalidateTenant(tenantId)
createOidcProvider(config, fetch?): { discovery, buildAuthorizationUrl, exchangeCode }
```

**Errors:** auth failures throw generic `[allinone/auth] Invalid credentials`
(no enumeration); reuse of a rotated refresh token revokes the whole session
family. OIDC verified-algorithms: RS256/ES256 only (`none` rejected);
expired/audience/nonce mismatches reject. Totp codes never replay.

## `@allinone/cms`

```ts
defineCmsCollection(name, fieldsDef)
new CmsStore()  // create / submitForReview / publish / unpublish / update
                // findByCollection / revisionsFor / restoreRevision
slugify(input): string
```

**Errors:** invalid status transitions throw `Invalid transition …`;
missing revisions/entries throw. Status machine is enforced:
`draft → in-review → published → archived`.

## `@allinone/infra`

```ts
new AuditLog()            // append / listForTenant / verifyChain (hash-chained)
new ApiKeyStore()         // create → { record, secret } / verify (timing-safe) / revoke
signWebhook / verifyWebhook(secret, body, timestamp, signature)
retryBackoffSeconds(attempt): number
new MemoryCache()         // CacheProvider (get/set/delete) with TTL
new SubscriptionStore()   // addPlan / subscribe / entitlement / usage / isLimitExceeded
new RateLimiter(max, windowSeconds)  .allow(key): boolean
createLogger(sink): { info, warn, error }      // structured JSON lines
createSmtpMailer(opts): NotificationProvider    // nodemailer SMTP + templates
escapeHtml(s) / renderTemplate(tpl, vars)
createWorkflowEngine(): WorkflowEngine         // tasks, approvals, retries
Workflows: engine.register/define/start/execute/approve/reject/history (tenant-scoped)
createWebhookDispatcher(): WebhookDispatcher     // signed dispatch + retries + dead-letter
dispatcher.subscribe(endpoint) / .dispatch(tenantId, { event, payload })
dispatcher.processDue() — attempt due deliveries (timer-driven)
deadLetters(tenantId) / deliveriesByEndpoint(id)
createNotificationCenter(provider?): NotificationCenter  // prefs + inbox
.notify({ tenantId, userId, email, title, body }) → { inApp, emailed }
.list(tenantId, userId) / .markRead / .markAllRead; prefs via setPreferences
createScheduler(): Scheduler                   // cron (5-field, UTC) + overlap guard
parseCron(expr) / nextRunAfter(expr, from) — pure next-fire calculator
searchAcross(adapter, collection, { query, fields, tenantId? }) — OR substring search
createSearchIndex(): MemorySearchIndex         // tokenized, prefix, tenant-scoped
buildAdminManifest({ actor, tenantId, rolesById, config? }): AdminManifest
createWorkflowEngine(): WorkflowEngine         // tasks, approvals, conditionals, retries
WorkflowEngine.register(name, handler) / .define(definition)
engine.start(definitionId, { tenantId, data? }): RunRecord
engine.execute(runId) / .approve(runId) / .reject(runId)
engine.history(tenantId): RunRecord[]          // tenant-scoped
aggregateHealth(checks): Promise<HealthStatus>
```

**Errors/policy:** invalid webhook signatures return false (stale timestamps
rejected); rate limiter fails open per-key but is window-scoped; entitlements
fail closed (no subscription → 0).
