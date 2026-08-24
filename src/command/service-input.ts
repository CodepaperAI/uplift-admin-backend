import { z } from "zod";

const PRICE = z.string().regex(/^\d+$/, "Price must be exact minor units").max(19).nullable();
const CURRENCY = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Currency must be a three-letter code")
  .transform((value) => value.toLowerCase())
  .nullable();
const PROVIDER_IDS = z.array(z.string().trim().min(1).max(255)).max(100);

function requirePriceCurrencyPair<T extends { listPriceMinor?: string | null; currency?: string | null }>(
  value: T,
  context: z.RefinementCtx,
): void {
  const hasPrice = value.listPriceMinor !== undefined && value.listPriceMinor !== null;
  const hasCurrency = value.currency !== undefined && value.currency !== null;
  if (hasPrice !== hasCurrency) {
    context.addIssue({
      code: "custom",
      path: hasPrice ? ["currency"] : ["listPriceMinor"],
      message: "List price and currency must be supplied together",
    });
  }
}

export const COMMAND_SERVICE_CREATE_INPUT = z
  .object({
    key: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    name: z.string().trim().min(2).max(160),
    kind: z.enum(["subscription", "one_time"]),
    listPriceMinor: PRICE,
    currency: CURRENCY,
    stripePriceIds: PROVIDER_IDS.default([]),
    ghlPipelineIds: PROVIDER_IDS.default([]),
    ghlCustomFieldValues: PROVIDER_IDS.default([]),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine(requirePriceCurrencyPair);

export const COMMAND_SERVICE_UPDATE_INPUT = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    kind: z.enum(["subscription", "one_time"]).optional(),
    listPriceMinor: PRICE.optional(),
    currency: CURRENCY.optional(),
    stripePriceIds: PROVIDER_IDS.optional(),
    ghlPipelineIds: PROVIDER_IDS.optional(),
    ghlCustomFieldValues: PROVIDER_IDS.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one service field is required",
  })
  .superRefine(requirePriceCurrencyPair);

export function uniqueProviderIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
