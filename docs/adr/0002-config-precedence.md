# ADR-0002 — Config Precedence + Security Invariants

Configuration precedence (highest → lowest):

1. **Platform security invariants** — cannot be overridden silently.
2. Explicit application security policies.
3. Application configuration (`createPlatform` options).
4. Preset defaults.
5. Platform defaults (`platformDefaults` in `@allinone/config`).

Invariants enforced by `assertSecure()` — throw on violation:

- `authorization.defaultDeny` must be `true` (even with
  `dangerouslyAllowInsecure: true`).
- `tenancy.enforceIsolation` must be `true`.
- Session cookies must be `httpOnly: true` + `secure: true` (relaxable
  only via explicit `dangerouslyAllowInsecure: true`, for local dev).
- Refresh token rotation must stay enabled.

Rationale: disabling default-deny or tenant isolation can never be a
legitimate local-dev convenience, whereas insecure cookies can — but only
with explicit opt-in so the risk is documented in code.
