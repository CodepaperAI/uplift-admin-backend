import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createOAuthState, verifyOAuthState } from "../utils/oauth-state";
import {
  decryptOAuthToken,
  encryptOAuthToken,
} from "../utils/oauth-token-crypto";
import {
  createOutreachUnsubscribeToken,
  verifyOutreachUnsubscribeToken,
} from "../utils/outreach-unsubscribe-token";
import {
  decryptPublishingSecret,
  encryptPublishingSecret,
} from "../utils/publishing-secret-crypto";

const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalOAuthStateSecret = process.env.OAUTH_STATE_SECRET;
const originalUnsubscribeSecret = process.env.OUTREACH_UNSUBSCRIBE_SECRET;

describe("security token boundaries", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "01".repeat(32);
    process.env.OAUTH_STATE_SECRET =
      "oauth-state-secret-material-that-is-at-least-32-bytes";
    process.env.OUTREACH_UNSUBSCRIBE_SECRET =
      "unsubscribe-secret-material-that-is-at-least-32-bytes";
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    if (originalOAuthStateSecret === undefined)
      delete process.env.OAUTH_STATE_SECRET;
    else process.env.OAUTH_STATE_SECRET = originalOAuthStateSecret;
    if (originalUnsubscribeSecret === undefined)
      delete process.env.OUTREACH_UNSUBSCRIBE_SECRET;
    else process.env.OUTREACH_UNSUBSCRIBE_SECRET = originalUnsubscribeSecret;
  });

  it("binds OAuth state to provider, user and signed context", () => {
    const state = createOAuthState({
      provider: "webflow",
      userId: "user-123",
      context: { businessId: "business-123", siteId: "site-123" },
    });
    expect(verifyOAuthState(state, "webflow")).toMatchObject({
      provider: "webflow",
      userId: "user-123",
      context: { businessId: "business-123", siteId: "site-123" },
    });
    expect(verifyOAuthState(state, "wix")).toBeNull();
    expect(verifyOAuthState(`${state.slice(0, -1)}x`, "webflow")).toBeNull();
  });

  it("binds encrypted OAuth credentials to one provider", () => {
    const stored = encryptOAuthToken("provider-secret", "shopify");
    expect(stored).not.toContain("provider-secret");
    expect(decryptOAuthToken(stored, "shopify")).toBe("provider-secret");
    expect(() => decryptOAuthToken(stored, "wix")).toThrow(
      "OAuth credential context mismatch",
    );
  });

  it("binds publishing ciphertext to one credential field", () => {
    const stored = encryptPublishingSecret(
      "wordpress-app-password",
      "wordpress-password",
    );
    expect(stored).not.toContain("wordpress-app-password");
    expect(decryptPublishingSecret(stored, "wordpress-password")).toBe(
      "wordpress-app-password",
    );
    expect(() =>
      decryptPublishingSecret(stored, "webflow-site-token"),
    ).toThrow("Publishing credential context mismatch");
  });

  it("requires a valid signed unsubscribe token", () => {
    const campaignId = "00000000-0000-4000-8000-000000000001";
    const token = createOutreachUnsubscribeToken(campaignId);
    expect(verifyOutreachUnsubscribeToken(token)).toBe(campaignId);
    expect(verifyOutreachUnsubscribeToken(campaignId)).toBeNull();
    expect(
      verifyOutreachUnsubscribeToken(`${token.slice(0, -1)}x`),
    ).toBeNull();
  });

  it("fails closed when dedicated secrets are missing or undersized", () => {
    delete process.env.OAUTH_STATE_SECRET;
    expect(() =>
      createOAuthState({ provider: "reddit", userId: "user-123" }),
    ).toThrow("OAuth state signing is unavailable");

    process.env.OUTREACH_UNSUBSCRIBE_SECRET = "short";
    expect(() =>
      createOutreachUnsubscribeToken(
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toThrow("Outreach unsubscribe signing is unavailable");
  });
});
