import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { zernioWebhookSignatureMatches } from "../services/zernio/zernio-webhook-signature";

describe("Zernio webhook signatures", () => {
  const secret = "test-secret-with-at-least-thirty-two-characters";
  const rawBody = JSON.stringify({ id: "evt_123", type: "post.published" });

  test("accepts the lowercase hex HMAC for the exact raw body", () => {
    const signature = createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    expect(zernioWebhookSignatureMatches(rawBody, signature, secret)).toBe(true);
  });

  test("rejects body changes, malformed signatures, and missing secrets", () => {
    const signature = createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    expect(
      zernioWebhookSignatureMatches(`${rawBody}\n`, signature, secret),
    ).toBe(false);
    expect(zernioWebhookSignatureMatches(rawBody, "not-a-signature", secret)).toBe(false);
    expect(zernioWebhookSignatureMatches(rawBody, signature, "")).toBe(false);
  });
});
