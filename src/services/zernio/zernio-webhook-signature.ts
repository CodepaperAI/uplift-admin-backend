import { createHmac, timingSafeEqual } from "node:crypto";

export function zernioWebhookSignatureMatches(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(
    Buffer.from(signature.toLowerCase(), "utf8"),
    Buffer.from(expected, "utf8"),
  );
}
