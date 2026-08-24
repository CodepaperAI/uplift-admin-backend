import type { Request, Response } from "express";
import { ZodError } from "zod";
import { executeLLM } from "../llm/index.llm";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import { ACCOUNT_SETUP } from "../validators/llm.validation";

export async function userBusinessSetup(req: Request, res: Response) {
  try {
    const body = req.body;
    const payload = ACCOUNT_SETUP.parse(body);
    const response = await executeLLM({
      websiteUrl: payload.websiteUrl,
      userId: payload.userId,
    });

    return sendSuccess(
      res,
      { businessId: response.businessId },
      "Account setup completed successfully",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to setup account", 500, error);
  }
}
