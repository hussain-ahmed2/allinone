import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { createOidcProvider, generateCodeVerifier, pkceChallenge } from "./oidc.js";

const ISSUER = "https://issuer.example.com";

interface TestKeys {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, string>;
}

function makeKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as Record<string, string>;
  return { kid: "test-key-1", privateKey, jwk };
}

function signJwt(
  privateKey: KeyObject,
  kid: string,
  payload: Record<string, unknown>,
  alg = "RS256",
): string {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: "my-client",
    sub: "user-123",
    email: "ada@example.com",
    name: "Ada",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

/** Mock fetch serving discovery + JWKS + token endpoints. */
function mockFetch(keys: TestKeys, idToken: string) {
  return async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    if (url.endsWith("/.well-known/openid-configuration")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authorization_endpoint: "https://issuer.example.com/authorize",
          token_endpoint: "https://issuer.example.com/token",
          jwks_uri: "https://issuer.example.com/jwks",
          issuer: ISSUER,
        }),
      };
    }
    if (url === "https://issuer.example.com/jwks") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys: [{ ...keys.jwk, kid: keys.kid }] }),
      };
    }
    if (url === "https://issuer.example.com/token") {
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(init?.body ?? "");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toBeTruthy();
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-123", id_token: idToken }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function makeProvider(fetchImpl: Parameters<typeof createOidcProvider>[1]) {
  return createOidcProvider(
    {
      id: "test",
      issuer: ISSUER,
      clientId: "my-client",
      redirectUri: "https://app.example.com/callback",
    },
    fetchImpl,
  );
}

describe("PKCE helpers", () => {
  it("challenge is base64url SHA-256 of the verifier", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
    expect(pkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceChallenge(verifier)).not.toBe(verifier);
  });
});

describe("OIDC flow (mocked issuer)", () => {
  it("builds an authorization URL with PKCE S256", async () => {
    const keys = makeKeys();
    const provider = makeProvider(mockFetch(keys, "unused"));
    const request = await provider.buildAuthorizationUrl();
    expect(request.url).toContain("https://issuer.example.com/authorize?");
    expect(request.url).toContain("code_challenge_method=S256");
    expect(request.url).toContain(`code_challenge=${pkceChallenge(request.codeVerifier)}`);
    expect(request.state).toBeTruthy();
    expect(request.nonce).toBeTruthy();
  });

  it("exchanges a code and returns verified claims", async () => {
    const keys = makeKeys();
    const idToken = signJwt(keys.privateKey, keys.kid, claims({ nonce: "n-1" }));
    const provider = makeProvider(mockFetch(keys, idToken));
    const result = await provider.exchangeCode({
      code: "auth-code",
      codeVerifier: generateCodeVerifier(),
      nonce: "n-1",
    });
    expect(result.user.sub).toBe("user-123");
    expect(result.user.email).toBe("ada@example.com");
    expect(result.accessToken).toBe("at-123");
  });

  it("rejects tampered signatures", async () => {
    const keys = makeKeys();
    const good = signJwt(keys.privateKey, keys.kid, claims());
    const parts = good.split(".");
    const h = parts[0] ?? "";
    const p = parts[1] ?? "";
    const s = parts[2] ?? "";
    const tampered = `${h}.${p}.${s.split("").reverse().join("")}`;
    const provider = makeProvider(mockFetch(keys, tampered));
    await expect(provider.exchangeCode({ code: "c", codeVerifier: "v" })).rejects.toThrow(
      /signature invalid/,
    );
  });

  it("rejects expired tokens and nonce mismatches", async () => {
    const keys = makeKeys();
    const expired = signJwt(keys.privateKey, keys.kid, claims({ exp: 1 }));
    const p1 = makeProvider(mockFetch(keys, expired));
    await expect(p1.exchangeCode({ code: "c", codeVerifier: "v" })).rejects.toThrow(/expired/);

    const nonced = signJwt(keys.privateKey, keys.kid, claims({ nonce: "expected" }));
    const p2 = makeProvider(mockFetch(keys, nonced));
    await expect(p2.exchangeCode({ code: "c", codeVerifier: "v", nonce: "wrong" })).rejects.toThrow(
      /nonce mismatch/,
    );
  });

  it("rejects unsigned (none) tokens", async () => {
    const keys = makeKeys();
    const payload = signJwt(keys.privateKey, keys.kid, claims()).split(".")[1] ?? "";
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
    const provider = makeProvider(mockFetch(keys, unsigned));
    await expect(provider.exchangeCode({ code: "c", codeVerifier: "v" })).rejects.toThrow(
      /Unsupported/,
    );
  });
});
