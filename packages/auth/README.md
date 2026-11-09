# @allinone/auth

Authentication + authorization for `allinone`: hashed passwords, sessions with
hashed/rotating refresh tokens, MFA (TOTP), SSO (OIDC), RBAC + ABAC with
default-deny.

## Identity + sessions

```ts
import { AuthService } from "@allinone/auth";

const auth = new AuthService();
await auth.register({ email, password, name });
const { session, refreshToken } = await auth.login({ email, password, tenantId });
const next = await auth.rotateRefresh(refreshToken); // reuse → family revoked
```

## TOTP MFA (RFC 6238, no dependencies)

```ts
const { secret, otpauthUri } = auth.startTotpEnrollment(userId, { issuer: "my-app" });
// Show otpauthUri as a QR code in the authenticator app.
const { recoveryCodes } = auth.confirmTotpEnrollment(userId, code); // show once!
auth.verifyTotp(userId, code); // replay-protected
auth.useRecoveryCode(userId, recoveryCodes[0]); // single-use
auth.disableTotp(userId, code);
```

Recovery codes are stored only as SHA-256 hashes. Each Totp counter is
accepted at most once per user.

## Passkeys (WebAuthn)

```ts
// Configure RP (relying party) via platform config:
const platform = createPlatform({
  database: { adapter: "memory" },
  auth: {
    passkeys: {
      enabled: true,
      rpID: "app.example.com",
      rpName: "My App",
      origin: "https://app.example.com",
    },
  },
});

// Ceremonies (your browser component calls navigator.credentials).
const { options, challenge } = await auth.beginPasskeyRegistration(userId);
const { credentialId } = await auth.finishPasskeyRegistration(userId, challenge, response);

const { challenge: authChallenge } = await auth.beginPasskeyAuthentication();
const { user } = await auth.finishPasskeyAuthentication(authChallenge, response);
auth.removePasskey(userId, credentialId);
```

Challenges are single-use with 5-minute expiry. Sign-counts must strictly
increase (cloned authenticators are rejected); a credential belongs to
exactly one user. Verification delegates to `@simplewebauthn/server` —
never custom crypto.

## Email verification + password recovery

Tokens are hashed at rest, single-use, and time-boxed (verification 24h,
reset 1h). The framework emails the token (see `@allinone/infra` mailer);
these APIs stay server-side.

```ts
// Verification: issue → email the link → consume.
const { token } = auth.requestEmailVerification(userId);
await auth.verifyEmail(token);

// Recovery: unknown emails return null — your HTTP layer must answer
// generically (no enumeration).
const issued = auth.requestPasswordReset(email);
if (issued) await mailer.send({ to: email, ... });
// On click (rotates password + revokes all sessions):
await auth.consumePasswordReset(token, newPassword);

// Authenticated change — verifies the current password first.
await auth.changePassword(userId, currentPassword, newPassword);
```

## Permission cache

Pure RBAC decisions can be memoized over any `CacheClient` (the infra
`MemoryCache` or the Redis cache provider). Keys are versioned per
actor + tenant — invalidation is a single counter bump:

```ts
import { createPermissionCache } from "@allinone/auth";

const permissions = createPermissionCache({ cache, ttlSeconds: 300 });
const allowed = await permissions.can(query, rolesById, tenantId);
await permissions.invalidateActor(userId); // role change for one user
await permissions.invalidateTenant(tenantId); // bulk role/policy change
```

Custom ABAC conditions depend on request attributes and are never cached
(evaluated fresh). Cache outages degrade to fresh evaluation — the cache
is never an authorization boundary.

## SSO (OIDC + PKCE)

```ts
import { createOidcProvider } from "@allinone/auth";

const provider = createOidcProvider({
  id: "google",
  issuer: "https://accounts.google.com",
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: "https://app.example.com/auth/callback",
});
const request = await provider.buildAuthorizationUrl(); // redirect browser here
// On callback: check state, then exchange + link account.
const { user: oidcUser } = await provider.exchangeCode({
  code,
  codeVerifier: request.codeVerifier,
  nonce: request.nonce,
});
const { user } = await auth.linkExternalIdentity("google", oidcUser);
```

ID tokens are verified RS256/ES256 against issuer JWKS (`iss`/`aud`/`exp`/
`nonce` enforced). Configure providers via `auth.providers` in platform
config.
