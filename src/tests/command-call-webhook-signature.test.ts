import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  verifyFathomWebhookSignature,
  verifyFirefliesWebhookSignature,
} from "../command/call-webhook-signature";

describe("Command call webhook signatures", () => {
  test("verifies Fireflies raw-body HMAC and rejects altered bodies", () => {
    const rawBody = JSON.stringify({ event: "Transcription completed", meeting_id: "m1" });
    const signature = `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`;
    expect(
      verifyFirefliesWebhookSignature({ rawBody, signature, secret: "secret" }),
    ).toBe(true);
    expect(
      verifyFirefliesWebhookSignature({ rawBody: `${rawBody}\n`, signature, secret: "secret" }),
    ).toBe(false);
  });

  test("verifies Fathom signed content and enforces replay tolerance", () => {
    const rawBody = JSON.stringify({ recording_id: 123 });
    const webhookId = "msg_1";
    const timestamp = "1786852800";
    const secretBytes = Buffer.from("fathom-test-secret");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const signature = createHmac("sha256", secretBytes)
      .update(`${webhookId}.${timestamp}.${rawBody}`)
      .digest("base64");
    const now = new Date(Number(timestamp) * 1000);
    expect(
      verifyFathomWebhookSignature({
        rawBody,
        webhookId,
        timestamp,
        signature: `v1,${signature}`,
        secret,
        now,
      }),
    ).toBe(true);
    expect(
      verifyFathomWebhookSignature({
        rawBody,
        webhookId,
        timestamp,
        signature,
        secret,
        now: new Date(now.getTime() + 301_000),
      }),
    ).toBe(false);
  });
});
