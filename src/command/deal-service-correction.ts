import { z } from "zod";

export const COMMAND_DEAL_SOURCE_TYPES = [
  "stripe_subscription",
  "ghl_subscription",
  "ghl_transaction",
  "legacy_sale",
] as const;

export const COMMAND_DEAL_SERVICE_CORRECTION_INPUT = z
  .object({
    serviceId: z.string().uuid(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();

export function commandDealCorrectionKey(
  sourceType: string,
  sourceId: string,
): string {
  return `${sourceType}\u0000${sourceId}`;
}
