import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.js";
import { PasskeyService } from "./passkeys.js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

/** Minimal stubs — the ceremony logic is what we test; crypto is delegated. */
function makeVerifiers() {
  return {
    verifyRegistration: async () => ({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "",
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([9, 9]),
          counter: 0,
        },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost:5173",
      },
    }),
    verifyAuthentication: async () => ({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-1",
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "http://localhost:5173",
        rpID: "localhost",
      },
    }),
  };
}

function makeService() {
  const v = makeVerifiers();
  return new PasskeyService({
    verifyRegistration: v.verifyRegistration as never,
    verifyAuthentication: v.verifyAuthentication as never,
  });
}

function regResponse(rawId = "cred-1"): RegistrationResponseJSON {
  return {
    rawId,
    id: rawId,
    response: {
      clientDataJSON: "",
      attestationObject: "",
      transports: ["internal"],
    },
    type: "public-key",
    clientExtensionResults: {},
  } as unknown as RegistrationResponseJSON;
}

function authResponse(rawId = "cred-1"): AuthenticationResponseJSON {
  return {
    rawId,
    id: rawId,
    response: {
      clientDataJSON: "",
      authenticatorData: "",
      signature: "",
      userHandle: null,
    },
    type: "public-key",
    clientExtensionResults: {},
  } as unknown as AuthenticationResponseJSON;
}

describe("PasskeyService ceremonies", () => {
  it("registers, authenticates, and increments sign-counts", async () => {
    const service = makeService();
    const { challenge } = await service.beginRegistration({ userId: "u1", userName: "a@b.c" });
    expect(challenge).toBeTruthy();
    const registered = await service.finishRegistration({
      userId: "u1",
      challenge,
      response: regResponse(),
    });
    expect(registered.credentialId).toBe("cred-1");
    expect(service.listCredentials("u1")).toHaveLength(1);

    // Challenge is single-use.
    await expect(
      service.finishRegistration({ userId: "u1", challenge, response: regResponse() }),
    ).rejects.toThrow(/challenge/);

    const { challenge: authChallenge } = await service.beginAuthentication();
    const result = await service.finishAuthentication({
      challenge: authChallenge,
      response: authResponse(),
    });
    expect(result.userId).toBe("u1");
    expect(result.signCount).toBe(1);

    // Replay of the same challenge is rejected.
    await expect(
      service.finishAuthentication({ challenge: authChallenge, response: authResponse() }),
    ).rejects.toThrow(/challenge/);
  });

  it("rejects duplicates, unknown credentials, and stale counters", async () => {
    const service = makeService();
    const { challenge: c1 } = await service.beginRegistration({ userId: "u1", userName: "a@b.c" });
    await service.finishRegistration({ userId: "u1", challenge: c1, response: regResponse() });

    // Same credential for another user is rejected.
    const { challenge: c2 } = await service.beginRegistration({ userId: "u2", userName: "x@y.z" });
    await expect(
      service.finishRegistration({ userId: "u2", challenge: c2, response: regResponse() }),
    ).rejects.toThrow(/already registered/);

    // Unknown credential id on auth.
    const { challenge: c3 } = await service.beginAuthentication();
    await expect(
      service.finishAuthentication({ challenge: c3, response: authResponse("unknown") }),
    ).rejects.toThrow(/not recognized/);

    // Counter must strictly increase.
    const v = makeVerifiers();
    const stale = new PasskeyService({
      verifyRegistration: v.verifyRegistration as never,
      verifyAuthentication: (async () => ({
        verified: true,
        authenticationInfo: {
          credentialID: "cred-1",
          newCounter: 0,
          userVerified: true,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
          origin: "http://localhost:5173",
          rpID: "localhost",
        },
      })) as never,
    });
    const { challenge: sc1 } = await stale.beginRegistration({ userId: "u1", userName: "a@b.c" });
    await stale.finishRegistration({ userId: "u1", challenge: sc1, response: regResponse() });
    const { challenge: sc2 } = await stale.beginAuthentication();
    await expect(
      stale.finishAuthentication({ challenge: sc2, response: authResponse() }),
    ).rejects.toThrow(/sign-count/);
  });
});

describe("AuthService passkey integration", () => {
  function makeAuth() {
    const v = makeVerifiers();
    return new AuthService({
      passkeys: {
        verifyRegistration: v.verifyRegistration as never,
        verifyAuthentication: v.verifyAuthentication as never,
      },
    });
  }

  it("gates registration/authentication on the user", async () => {
    const auth = makeAuth();
    const user = await auth.register({
      email: "pk@example.com",
      password: "correct horse battery",
      name: "PK",
    });

    const { challenge } = await auth.beginPasskeyRegistration(user.id);
    const registered = await auth.finishPasskeyRegistration(user.id, challenge, regResponse());
    expect(registered.credentialId).toBe("cred-1");
    expect(auth.listPasskeys(user.id)).toHaveLength(1);

    const { challenge: authChallenge } = await auth.beginPasskeyAuthentication();
    const result = await auth.finishPasskeyAuthentication(authChallenge, authResponse());
    expect(result.user.id).toBe(user.id);

    await expect(auth.beginPasskeyRegistration("ghost")).rejects.toThrow(/not found/);
    await expect(auth.finishPasskeyAuthentication(authChallenge, authResponse())).rejects.toThrow(
      /challenge/,
    );
  });

  it("removes passkeys", async () => {
    const auth = makeAuth();
    const user = await auth.register({
      email: "pk2@example.com",
      password: "correct horse battery",
      name: "PK2",
    });
    const { challenge } = await auth.beginPasskeyRegistration(user.id);
    await auth.finishPasskeyRegistration(user.id, challenge, regResponse());
    const [cred] = auth.listPasskeys(user.id);
    expect(auth.removePasskey(user.id, cred!.credentialId)).toBe(true);
    expect(auth.listPasskeys(user.id)).toHaveLength(0);
    expect(auth.removePasskey(user.id, cred!.credentialId)).toBe(false);
  });
});
