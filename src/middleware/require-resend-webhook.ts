import type { NextFunction, Request, Response } from "express";
import { Resend } from "resend";
import { sendError } from "../utils/response.utils";

type RawBodyRequest = Request & { rawBody?: string };

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function requireResendWebhook(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
): void {
  const webhookSecret =
    process.env.RESEND_WEBHOOK_SECRET?.trim() ||
    process.env.EMAIL_WEBHOOK_SECRET?.trim() ||
    "";
  const payload = req.rawBody;
  const id = headerValue(req.headers["svix-id"]);
  const timestamp = headerValue(req.headers["svix-timestamp"]);
  const signature = headerValue(req.headers["svix-signature"]);

  if (
    Buffer.byteLength(webhookSecret, "utf8") < 32 ||
    !payload ||
    !id ||
    !timestamp ||
    !signature
  ) {
    sendError(res, "Unauthorized", 401);
    return;
  }

  try {
    new Resend("re_webhook_verification_only").webhooks.verify({
      payload,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
    next();
  } catch {
    sendError(res, "Unauthorized", 401);
  }
}
