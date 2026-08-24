import type { Request, Response } from "express";
import { z } from "zod";
import { EmailService } from "../services/email.service";
import { sendError, sendSuccess } from "../utils/response.utils";

const emailService = new EmailService();

const PASSWORD_RESET_EMAIL_SCHEMA = z.object({
  userEmail: z.string().email(),
  userName: z.string().optional(),
  resetUrl: z.string().url(),
});

const CHANGE_EMAIL_VERIFICATION_SCHEMA = z.object({
  userEmail: z.string().email(),
  userName: z.string().optional(),
  verificationUrl: z.string().url(),
});

function getSafeUserName(userName?: string): string {
  const trimmed = userName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "there";
}

export async function sendPasswordResetEmailInternal(
  req: Request,
  res: Response
) {
  try {
    const payload = PASSWORD_RESET_EMAIL_SCHEMA.parse(req.body);

    const result = await emailService.sendPasswordResetEmail({
      userEmail: payload.userEmail,
      userName: getSafeUserName(payload.userName),
      resetUrl: payload.resetUrl,
    });

    if (!result.success) {
      return sendError(
        res,
        result.error || "Failed to send password reset email",
        500
      );
    }

    return sendSuccess(
      res,
      { emailId: result.emailId },
      "Password reset email sent successfully"
    );
  } catch (error: any) {
    console.error("Error sending internal password reset email:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.flatten(),
      });
    }
    return sendError(res, "Failed to send password reset email", 500, error);
  }
}

export async function sendChangeEmailVerificationEmailInternal(
  req: Request,
  res: Response
) {
  try {
    const payload = CHANGE_EMAIL_VERIFICATION_SCHEMA.parse(req.body);

    const result = await emailService.sendChangeEmailVerificationEmail({
      userEmail: payload.userEmail,
      userName: getSafeUserName(payload.userName),
      verificationUrl: payload.verificationUrl,
    });

    if (!result.success) {
      return sendError(
        res,
        result.error || "Failed to send verification email",
        500
      );
    }

    return sendSuccess(
      res,
      { emailId: result.emailId },
      "Verification email sent successfully"
    );
  } catch (error: any) {
    console.error("Error sending internal verification email:", error);
    if (error instanceof z.ZodError) {
      return sendError(res, "Invalid request data", 400, {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.flatten(),
      });
    }
    return sendError(res, "Failed to send verification email", 500, error);
  }
}
