import { z } from "zod";

const OPTIONAL_TEXT = z.string().trim().min(1).max(255).nullable().optional();
const BASE_PAY = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Base pay must be a non-negative decimal")
  .max(24)
  .nullable()
  .optional();
const CURRENCY = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Currency must be a three-letter code")
  .transform((value) => value.toLowerCase())
  .nullable()
  .optional();

function requireMoneyCurrencyPair<T extends { basePay?: string | null; currency?: string | null }>(
  value: T,
  context: z.RefinementCtx,
): void {
  const hasBasePay = value.basePay !== undefined && value.basePay !== null;
  const hasCurrency = value.currency !== undefined && value.currency !== null;
  if (hasBasePay !== hasCurrency) {
    context.addIssue({
      code: "custom",
      path: hasBasePay ? ["currency"] : ["basePay"],
      message: "Base pay and currency must be supplied together",
    });
  }
}

function requireValidEmploymentRange<T extends { startDate?: Date; endDate?: Date | null }>(
  value: T,
  context: z.RefinementCtx,
): void {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    context.addIssue({
      code: "custom",
      path: ["endDate"],
      message: "End date must be on or after the start date",
    });
  }
}

export const COMMAND_REP_CREATE_INPUT = z
  .object({
    userId: z.string().uuid(),
    name: z.string().trim().min(2).max(120),
    basePay: BASE_PAY,
    currency: CURRENCY,
    ghlUserId: OPTIONAL_TEXT,
    startDate: z.coerce.date(),
    endDate: z.coerce.date().nullable().optional(),
    isActive: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    requireMoneyCurrencyPair(value, context);
    requireValidEmploymentRange(value, context);
  });

export const COMMAND_REP_UPDATE_INPUT = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    basePay: BASE_PAY,
    currency: CURRENCY,
    ghlUserId: OPTIONAL_TEXT,
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one rep field is required",
  })
  .superRefine((value, context) => {
    requireMoneyCurrencyPair(value, context);
    requireValidEmploymentRange(value, context);
  });

export function normalizeOptionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : value.trim();
}
