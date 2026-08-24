import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  ApiTokenConfigurationError,
  generateApiTokenCredential,
  hashToken,
  isPublicTokenTransportAllowed,
  parseApiTokenV2,
  verifyApiTokenV2Digest,
} from "../utils/api-token.utils";

const originalCurrentSecret = process.env.API_TOKEN_HMAC_SECRET;
const originalPreviousSecret = process.env.API_TOKEN_HMAC_PREVIOUS_SECRET;

const CURRENT_SECRET =
  "current-api-token-hmac-secret-material-at-least-32-bytes";
const PREVIOUS_SECRET =
  "previous-api-token-hmac-secret-material-at-least-32-bytes";

describe("API token v2 cryptography", () => {
  beforeEach(() => {
    process.env.API_TOKEN_HMAC_SECRET = CURRENT_SECRET;
    delete process.env.API_TOKEN_HMAC_PREVIOUS_SECRET;
  });

  afterAll(() => {
    if (originalCurrentSecret === undefined) {
      delete process.env.API_TOKEN_HMAC_SECRET;
    } else {
      process.env.API_TOKEN_HMAC_SECRET = originalCurrentSecret;
    }
    if (originalPreviousSecret === undefined) {
      delete process.env.API_TOKEN_HMAC_PREVIOUS_SECRET;
    } else {
      process.env.API_TOKEN_HMAC_PREVIOUS_SECRET = originalPreviousSecret;
    }
  });

  it("generates a split identifier and 256-bit URL-safe secret", () => {
    const credential = generateApiTokenCredential();
    const parsed = parseApiTokenV2(credential.plainToken);

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(credential.id);
    expect(parsed?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.tokenDigest).toStartWith("hmac-sha256:v2:");
    expect(credential.tokenDigest).not.toContain(parsed?.secret ?? "");
    expect(credential.tokenPrefix).not.toContain(parsed?.secret ?? "");
  });

  it("produces independently random secrets and identifiers", () => {
    const first = generateApiTokenCredential();
    const second = generateApiTokenCredential();

    expect(first.id).not.toBe(second.id);
    expect(first.plainToken).not.toBe(second.plainToken);
    expect(first.tokenDigest).not.toBe(second.tokenDigest);
  });

  it("accepts the original token and rejects tampering", () => {
    const credential = generateApiTokenCredential();
    const valid = verifyApiTokenV2Digest(
      credential.plainToken,
      credential.tokenDigest,
    );
    const tamperedToken = `${credential.plainToken.slice(0, -1)}${
      credential.plainToken.endsWith("A") ? "B" : "A"
    }`;
    const tampered = verifyApiTokenV2Digest(
      tamperedToken,
      credential.tokenDigest,
    );

    expect(valid).toEqual({
      valid: true,
      currentDigest: credential.tokenDigest,
      needsRehash: false,
    });
    expect(tampered.valid).toBe(false);
  });

  it("supports one previous HMAC key and requests transparent rehash", () => {
    process.env.API_TOKEN_HMAC_SECRET = PREVIOUS_SECRET;
    const credential = generateApiTokenCredential();

    process.env.API_TOKEN_HMAC_SECRET = CURRENT_SECRET;
    process.env.API_TOKEN_HMAC_PREVIOUS_SECRET = PREVIOUS_SECRET;
    const verification = verifyApiTokenV2Digest(
      credential.plainToken,
      credential.tokenDigest,
    );

    expect(verification.valid).toBe(true);
    expect(verification.needsRehash).toBe(true);
    expect(verification.currentDigest).not.toBe(credential.tokenDigest);
  });

  it("does not confuse legacy SHA-256 hashes with v2 HMAC digests", () => {
    const credential = generateApiTokenCredential();

    expect(
      verifyApiTokenV2Digest(
        credential.plainToken,
        hashToken(credential.plainToken),
      ).valid,
    ).toBe(false);
  });

  it("allows v2 credentials only in authentication headers", () => {
    const { plainToken } = generateApiTokenCredential();

    expect(
      isPublicTokenTransportAllowed({
        source: "authorization",
        token: plainToken,
      }),
    ).toBe(true);
    expect(
      isPublicTokenTransportAllowed({ source: "x-api-key", token: plainToken }),
    ).toBe(true);
    expect(
      isPublicTokenTransportAllowed({ source: "path", token: plainToken }),
    ).toBe(false);
    expect(
      isPublicTokenTransportAllowed({ source: "query", token: plainToken }),
    ).toBe(false);
  });

  it("fails closed for missing or undersized HMAC secrets", () => {
    delete process.env.API_TOKEN_HMAC_SECRET;
    expect(() => generateApiTokenCredential()).toThrow(
      ApiTokenConfigurationError,
    );

    process.env.API_TOKEN_HMAC_SECRET = "too-short";
    expect(() => generateApiTokenCredential()).toThrow(
      ApiTokenConfigurationError,
    );
  });
});
