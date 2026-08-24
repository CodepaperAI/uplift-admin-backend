import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyFirefliesWebhookSignature(input: {
  rawBody: string;
  signature: string | undefined;
  secret: string;
}): boolean {
  if (!input.rawBody || !input.signature || !input.secret) return false;
  const provided = input.signature.trim().toLowerCase();
  if (!/^sha256=[a-f0-9]{64}$/.test(provided)) return false;
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex")}`;
  return safeEqual(expected, provided);
}

export function verifyFathomWebhookSignature(input: {
  rawBody: string;
  webhookId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  if (
    !input.rawBody ||
    !input.webhookId ||
    !input.timestamp ||
    !input.signature ||
    !input.secret.startsWith("whsec_")
  ) {
    return false;
  }
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (
    Math.abs(nowSeconds - timestampSeconds) >
    (input.toleranceSeconds ?? 300)
  ) {
    return false;
  }
  let decodedSecret: Buffer;
  try {
    decodedSecret = Buffer.from(input.secret.slice("whsec_".length), "base64");
  } catch {
    return false;
  }
  if (decodedSecret.length === 0) return false;
  const expected = createHmac("sha256", decodedSecret)
    .update(`${input.webhookId}.${input.timestamp}.${input.rawBody}`)
    .digest("base64");
  const candidates = input.signature
    .split(/\s+/)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) =>
      part.startsWith("v1=") || part.startsWith("v1,")
        ? [part.slice(3)]
        : part === "v1"
          ? []
          : [part],
    );
  return candidates.some((candidate) => safeEqual(expected, candidate));
}
