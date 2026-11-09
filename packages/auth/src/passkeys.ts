/**
 * Passkeys (WebAuthn) orchestration — dependency-aware ceremonies on top
 * of @simplewebauthn/server.
 *
 * Security rules:
 *  - Challenges are single-use + 5-minute expiry.
 *  - Sign-count is verified and always incremented (counter must exceed
 *    the stored value) — cloned authenticators are detected on use.
 *  - A credential id can belong to exactly ONE user globally.
 *  - Verification itself is delegated to @simplewebauthn/server (never
 *    custom crypto); the injectable `verify*` options let tests stub it.
 *
 * Server responsibilities stop at the ceremony boundary: your app runs a
 * WebAuthn client in the browser and posts the ceremony responses here.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

export interface PasskeyCredential {
  credentialId: string;
  /** base64url public key material (as returned by the authenticator). */
  publicKey: string;
  signCount: number;
  transports: string[];
  createdAt: string;
}

export interface PasskeysOptions {
  rpID?: string;
  rpName?: string;
  origin?: string | readonly string[];
  /** Injectable verifier functions — tests stub these (no real authenticator). */
  verifyRegistration?: typeof verifyRegistrationResponse;
  verifyAuthentication?: typeof verifyAuthenticationResponse;
}

interface PendingChallenge {
  userId?: string;
  kind: "registration" | "authentication";
  createdAt: number;
}

export class PasskeyService {
  readonly #rpID: string;
  readonly #rpName: string;
  readonly #origin: string | string[];
  readonly #verifyRegistration: typeof verifyRegistrationResponse;
  readonly #verifyAuthentication: typeof verifyAuthenticationResponse;
  readonly #challenges = new Map<string, PendingChallenge>();
  /** userId -> credentials (per-user list). */
  readonly #credentials = new Map<string, PasskeyCredential[]>();

  constructor(options: PasskeysOptions = {}) {
    this.#rpID = options.rpID ?? "localhost";
    this.#rpName = options.rpName ?? "allinone";
    this.#origin =
      options.origin === undefined
        ? "http://localhost:5173"
        : typeof options.origin === "string"
          ? options.origin
          : [...options.origin];
    this.#verifyRegistration = options.verifyRegistration ?? verifyRegistrationResponse;
    this.#verifyAuthentication = options.verifyAuthentication ?? verifyAuthenticationResponse;
  }

  /** Begin registration — caller shows the options to the WebAuthn client. */
  async beginRegistration(input: {
    userId: string;
    userName: string;
    displayName?: string;
  }): Promise<{ options: unknown; challenge: string }> {
    const existing = this.#credentials.get(input.userId) ?? [];
    const options = await generateRegistrationOptions({
      rpID: this.#rpID,
      rpName: this.#rpName,
      userID: Buffer.from(input.userId),
      userName: input.userName,
      userDisplayName: input.displayName ?? input.userName,
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: [],
      })),
    });
    const challenge = options.challenge;
    this.#challenges.set(challenge, {
      userId: input.userId,
      kind: "registration",
      createdAt: Date.now(),
    });
    return { options, challenge };
  }

  /**
   * Finish registration — verifies attestation and stores the credential.
   * The caller passes back the `challenge` from `beginRegistration`.
   */
  async finishRegistration(input: {
    userId: string;
    challenge: string;
    response: RegistrationResponseJSON;
  }): Promise<{ credentialId: string }> {
    const pending = this.#consumeChallenge(input.challenge, "registration");
    if (pending.userId !== input.userId) {
      throw new Error("[allinone/auth] Passkey challenge user mismatch");
    }
    const verification = await this.#verifyRegistration({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: this.#origin,
      expectedRPID: this.#rpID,
    });
    if (!verification.verified) {
      throw new Error("[allinone/auth] Passkey attestation did not verify");
    }
    const info = verification.registrationInfo;
    const credentialId = info.credential.id;
    const conflicts = [...this.#credentials.values()]
      .flat()
      .some((c) => c.credentialId === credentialId);
    if (conflicts) {
      throw new Error("[allinone/auth] Passkey credential already registered");
    }
    const credential: PasskeyCredential = {
      credentialId,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
      signCount: info.credential.counter,
      transports: input.response.response.transports ?? [],
      createdAt: new Date().toISOString(),
    };
    const list = this.#credentials.get(input.userId) ?? [];
    list.push(credential);
    this.#credentials.set(input.userId, list);
    return { credentialId };
  }

  /** Begin authentication — empty list means a discoverable (resident) flow. */
  async beginAuthentication(): Promise<{ options: unknown; challenge: string }> {
    const options = await generateAuthenticationOptions({ rpID: this.#rpID });
    const challenge = options.challenge;
    this.#challenges.set(challenge, { kind: "authentication", createdAt: Date.now() });
    return { options, challenge };
  }

  /**
   * Finish authentication — verifies and increments the sign-count.
   * The caller passes back the `challenge` from `beginAuthentication`.
   */
  async finishAuthentication(input: {
    challenge: string;
    response: AuthenticationResponseJSON;
  }): Promise<{ userId: string; signCount: number }> {
    this.#consumeChallenge(input.challenge, "authentication");
    const owner = this.#findOwner(input.response.rawId);
    if (!owner) {
      throw new Error("[allinone/auth] Passkey credential not recognized");
    }
    const verification = await this.#verifyAuthentication({
      response: input.response,
      expectedChallenge: input.challenge,
      expectedOrigin: this.#origin,
      expectedRPID: this.#rpID,
      credential: {
        id: owner.credential.credentialId,
        publicKey: Buffer.from(owner.credential.publicKey, "base64url"),
        counter: owner.credential.signCount,
      },
    });
    if (!verification.verified) {
      throw new Error("[allinone/auth] Passkey assertion did not verify");
    }
    const newCount = verification.authenticationInfo.newCounter;
    if (newCount <= owner.credential.signCount) {
      throw new Error("[allinone/auth] Passkey sign-count did not increase (possible clone)");
    }
    owner.credential.signCount = newCount;
    return { userId: owner.userId, signCount: newCount };
  }

  /** List a user's registered passkeys. */
  listCredentials(userId: string): PasskeyCredential[] {
    return [...(this.#credentials.get(userId) ?? [])];
  }

  /** Remove one of a user's passkeys. Returns false when unknown. */
  removeCredential(userId: string, credentialId: string): boolean {
    const list = this.#credentials.get(userId);
    if (!list) return false;
    const next = list.filter((c) => c.credentialId !== credentialId);
    if (next.length === list.length) return false;
    this.#credentials.set(userId, next);
    return true;
  }

  #consumeChallenge(challenge: string, kind: "registration" | "authentication"): PendingChallenge {
    const pending = this.#challenges.get(challenge);
    this.#challenges.delete(challenge); // single-use
    if (!pending || pending.kind !== kind) {
      throw new Error("[allinone/auth] Invalid or consumed passkey challenge");
    }
    if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
      throw new Error("[allinone/auth] Expired passkey challenge");
    }
    return pending;
  }

  #findOwner(credentialId: string): { userId: string; credential: PasskeyCredential } | null {
    for (const [userId, list] of this.#credentials) {
      const credential = list.find((c) => c.credentialId === credentialId);
      if (credential) return { userId, credential };
    }
    return null;
  }
}
