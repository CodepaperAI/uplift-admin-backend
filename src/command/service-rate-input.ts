import { z } from "zod";

const RATE = z
  .string()
  .regex(/^0(?:\.\d{1,6})?$|^1(?:\.0{1,6})?$/, "Rate must be between 0 and 1")
  .max(8);

export const COMMAND_SERVICE_RATE_INPUT = z
  .object({
    effectiveFrom: z.coerce.date(),
    firstSaleRate: RATE,
    recurringRate: RATE,
    status: z.enum(["draft", "approved"]).default("draft"),
  })
  .strict();
