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
