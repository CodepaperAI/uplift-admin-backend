import { z } from "zod";

export const COMMAND_COST_INPUT = z
  .object({
    category: z.enum(["acquisition", "delivery"]),
    costCategory: z.string().trim().min(2).max(100),
    vendor: z.string().trim().min(2).max(100),
    amountMinor: z.string().regex(/^\d+$/).max(19),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    description: z.string().trim().min(2).max(500),
    occurredAt: z.coerce.date(),
  })
  .strict();
