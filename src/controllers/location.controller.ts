import type { Response } from "express";
import { z, ZodError } from "zod";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { autocompleteAddress } from "../services/address-autocomplete.service";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";

const addressAutocompleteSchema = z
  .object({
    country: z.string().trim().max(80).optional(),
    q: z.string().trim().min(3).max(180),
  })
  .strict();

export async function getAddressAutocomplete(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const input = addressAutocompleteSchema.parse(req.query);
    const result = await autocompleteAddress({
      country: input.country,
      query: input.q.replace(/\s+/g, " "),
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", "Authorization");
    return sendSuccess(res, result, "Address suggestions retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Address autocomplete request failed", error);
    return sendError(res, "Request could not be completed", 500);
  }
}
