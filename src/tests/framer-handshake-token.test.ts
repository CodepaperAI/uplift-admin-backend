import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createFramerHandshakeToken,
  getFramerHandshakeLookupId,
  getFramerHandshakeTokenDigest,
  verifyFramerHandshakeToken,
} from "../utils/framer-handshake-token";

const ORIGINAL_FRAMER_SECRET = process.env.FRAMER_HANDSHAKE_HMAC_SECRET;
const ORIGINAL_API_SECRET = process.env.API_TOKEN_HMAC_SECRET;

describe("Framer handshake credential boundaries", () => {
  beforeEach(() => {
    process.env.FRAMER_HANDSHAKE_HMAC_SECRET =
      "framer-handshake-test-secret-at-least-32-bytes";
    delete process.env.API_TOKEN_HMAC_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_FRAMER_SECRET === undefined) {
      delete process.env.FRAMER_HANDSHAKE_HMAC_SECRET;
    } else {
      process.env.FRAMER_HANDSHAKE_HMAC_SECRET = ORIGINAL_FRAMER_SECRET;
    }
    if (ORIGINAL_API_SECRET === undefined) {
      delete process.env.API_TOKEN_HMAC_SECRET;
    } else {
      process.env.API_TOKEN_HMAC_SECRET = ORIGINAL_API_SECRET;
    }
  });

  it("issues 256-bit purpose-bound credentials without storing the secret", () => {
    const credential = createFramerHandshakeToken("read");
    expect(credential.token).toMatch(
      /^frh_v2\.read\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(credential.id).not.toBe(credential.token);
    expect(credential.digest).not.toContain(credential.token);
    expect(getFramerHandshakeLookupId(credential.token, "read")).toBe(
      credential.id,
    );
    expect(
      getFramerHandshakeTokenDigest(credential.token, "read"),
    ).toBe(credential.digest);
  });

  it("rejects purpose confusion, token tampering, and digest tampering", () => {
    const credential = createFramerHandshakeToken("exchange");
    expect(
      verifyFramerHandshakeToken(
        credential.token,
        "exchange",
        credential.digest,
      ),
    ).toBe(true);
    expect(
      verifyFramerHandshakeToken(credential.token, "connect", credential.digest),
    ).toBe(false);
    expect(
      verifyFramerHandshakeToken(
        `${credential.token.slice(0, -1)}x`,
        "exchange",
        credential.digest,
      ),
    ).toBe(false);
    expect(
      verifyFramerHandshakeToken(
        credential.token,
        "exchange",
        `${credential.digest.slice(0, -1)}${credential.digest.endsWith("0") ? "1" : "0"}`,
      ),
    ).toBe(false);
  });

  it("fails closed when the HMAC secret is unavailable or weak", () => {
    delete process.env.FRAMER_HANDSHAKE_HMAC_SECRET;
    delete process.env.API_TOKEN_HMAC_SECRET;
    expect(() => createFramerHandshakeToken("connect")).toThrow(
      "Framer handshake signing is unavailable",
    );

    process.env.FRAMER_HANDSHAKE_HMAC_SECRET = "weak";
    expect(() => createFramerHandshakeToken("connect")).toThrow(
      "Framer handshake signing is unavailable",
    );
  });
});
