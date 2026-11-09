/**
 * OAuth 2.0 / OpenID Connect provider — dependency-free (fetch + node:crypto).
 *
 * Flow: authorization-code + PKCE (S256) with `state` + `nonce`.
 *  1. `buildAuthorizationUrl()` — browser redirect with PKCE challenge.
 *  2. `exchangeCode()` — server-to-server code exchange + ID token
 *     verification against the issuer's discovery + JWKS.
 *
 * Security:
 *  - PKCE challenge is SHA-256 (never plain) — the verifier never
 *    leaves the server.
 *  - ID tokens are verified RS256/ES256 against issuer JWKS (`kid`
 *    lookup), `iss`/`aud`/`exp` enforced. Unsigned (`none`) tokens
 *    are rejected.
 *  - `state` and `nonce` must round-trip; callers keep state in an
 *    httpOnly cookie or short-lived session (see `StateStore`).
 */
import {
  createHash,
  randomBytes,
  createPublicKey,
  createVerify,
  type KeyObject,
} from "node:crypto";

export interface OidcProviderConfig {
  /** Stable local id, e.g. "google" | "okta" | "keycloak". */
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface OidcUser {
  sub: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
}

export interface OidcExchangeResult {
  user: OidcUser;
  accessToken: string;
  /** Raw claims — keep server-side; never expose to browsers. */
  claims: Record<string, unknown>;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function defaultFetch(): FetchFn {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { ok: response.ok, status: response.status, json: () => response.json() };
  };
}

/** Short-lived state store — clients may swap for Redis/DB. */
export class InMemoryStateStore {
  readonly #pending = new Map<string, { state: string; createdAt: number }>();

  add(state: string): void {
    this.#pending.set(state, { state, createdAt: Date.now() });
  }

  /** Single-use + 10-minute expiry. Returns true when valid. */
  consume(state: string): boolean {
    const entry = this.#pending.get(state);
    this.#pending.delete(state);
    if (!entry) return false;
    return Date.now() - entry.createdAt <= 10 * 60 * 1000;
  }
}

/** RFC 7636 code challenge (S256). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Generate a PKCE code verifier (43–128 chars). */
export function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** Generate a state/nonce token. */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Create an OIDC provider (discovery cached after first use). */
export function createOidcProvider(config: OidcProviderConfig, fetchFn?: FetchFn) {
  const fetchImpl = fetchFn ?? defaultFetch();
  let discoveryPromise: Promise<Discovery> | undefined;

  async function discovery(): Promise<Discovery> {
    discoveryPromise ??= (async () => {
      const issuer = config.issuer.replace(/\/$/, "");
      const response = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
      if (!response.ok) {
        throw new Error(
          `[allinone/auth] OIDC discovery failed for ${config.id}: HTTP ${String(response.status)}`,
        );
      }
      const data = (await response.json()) as Partial<Discovery>;
      if (!data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri) {
        throw new Error(`[allinone/auth] OIDC discovery for "${config.id}" is incomplete`);
      }
      return data as Discovery;
    })();
    return discoveryPromise;
  }

  async function jwksKeys(): Promise<Record<string, KeyObject>> {
    const { jwks_uri } = await discovery();
    const response = await fetchImpl(jwks_uri);
    if (!response.ok) {
      throw new Error(`[allinone/auth] JWKS fetch failed: HTTP ${String(response.status)}`);
    }
    const { keys } = (await response.json()) as {
      keys?: {
        kid?: string;
        kty: string;
        n?: string;
        e?: string;
        crv?: string;
        x?: string;
        y?: string;
      }[];
    };
    const out: Record<string, KeyObject> = {};
    for (const key of keys ?? []) {
      if (!key.kid) continue;
      const jwk =
        key.kty === "RSA"
          ? { kty: "RSA", n: key.n, e: key.e }
          : { kty: "EC", crv: key.crv, x: key.x, y: key.y };
      out[key.kid] = createPublicKey({ key: jwk, format: "jwk" } as never);
    }
    return out;
  }

  function verifyIdToken(
    token: string,
    keys: Record<string, KeyObject>,
    opts: { expectedNonce?: string },
  ): Record<string, unknown> {
    const parts = token.split(".");
    const headerPart = parts[0];
    const payloadPart = parts[1];
    const signaturePart = parts[2];
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new Error("[allinone/auth] Malformed ID token");
    }
    const header = decodeJwtPart(headerPart);
    const alg = header["alg"];
    if (alg !== "RS256" && alg !== "ES256") {
      throw new Error(`[allinone/auth] Unsupported ID token algorithm: ${String(alg)}`);
    }
    const kid = header["kid"];
    if (typeof kid !== "string" || !keys[kid]) {
      throw new Error("[allinone/auth] ID token references unknown signing key");
    }
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    const signature = Buffer.from(signaturePart, "base64url");
    if (!verifier.verify(keys[kid], signature)) {
      throw new Error("[allinone/auth] ID token signature invalid");
    }
    const claims = decodeJwtPart(payloadPart);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims["iss"] !== config.issuer.replace(/\/$/, "")) {
      throw new Error("[allinone/auth] ID token issuer mismatch");
    }
    if (claims["aud"] !== config.clientId) {
      throw new Error("[allinone/auth] ID token audience mismatch");
    }
    if (typeof claims["exp"] !== "number" || claims["exp"] <= nowSeconds) {
      throw new Error("[allinone/auth] ID token expired");
    }
    if (opts.expectedNonce && claims["nonce"] !== opts.expectedNonce) {
      throw new Error("[allinone/auth] ID token nonce mismatch");
    }
    return claims;
  }

  return {
    config,
    discovery,
    /** Build the authorization redirect URL (PKCE S256). */
    async buildAuthorizationUrl(): Promise<AuthorizationRequest> {
      const { authorization_endpoint } = await discovery();
      const state = generateState();
      const nonce = generateState();
      const codeVerifier = generateCodeVerifier();
      const params: Record<string, string> = {
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: (config.scopes ?? ["openid", "profile", "email"]).join(" "),
        state,
        nonce,
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: "S256",
      };
      const separator = authorization_endpoint.includes("?") ? "&" : "?";
      return {
        url: `${authorization_endpoint}${separator}${form(params)}`,
        state,
        codeVerifier,
        nonce,
      };
    },
    /**
     * Exchange a callback `code` for tokens and verify the ID token.
     * Caller must have kept `codeVerifier` + `nonce` from
     * `buildAuthorizationUrl` and must check `state`.
     */
    async exchangeCode(input: {
      code: string;
      codeVerifier: string;
      nonce?: string;
    }): Promise<OidcExchangeResult> {
      const { token_endpoint } = await discovery();
      const body: Record<string, string> = {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        code_verifier: input.codeVerifier,
      };
      if (config.clientSecret) body["client_secret"] = config.clientSecret;
      const response = await fetchImpl(token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form(body),
      });
      if (!response.ok) {
        throw new Error(
          `[allinone/auth] OIDC token exchange failed: HTTP ${String(response.status)}`,
        );
      }
      const data = (await response.json()) as {
        access_token?: string;
        id_token?: string;
      };
      if (!data.access_token || !data.id_token) {
        throw new Error("[allinone/auth] OIDC token response is incomplete");
      }
      const claims = verifyIdToken(data.id_token, await jwksKeys(), {
        ...(input.nonce ? { expectedNonce: input.nonce } : {}),
      });
      const sub = claims["sub"];
      if (typeof sub !== "string" || sub.length === 0) {
        throw new Error("[allinone/auth] ID token missing subject");
      }
      const user: OidcUser = {
        sub,
        ...(typeof claims["email"] === "string" ? { email: claims["email"] } : {}),
        ...(typeof claims["name"] === "string" ? { name: claims["name"] } : {}),
        ...(typeof claims["email_verified"] === "boolean"
          ? { emailVerified: claims["email_verified"] }
          : {}),
      };
      return { user, accessToken: data.access_token, claims };
    },
  };
}

export type OidcProvider = ReturnType<typeof createOidcProvider>;
