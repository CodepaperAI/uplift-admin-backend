import z from "zod";

export const GET_ALL_BACKLINKS = z
  .object({
    userId: z.string(),
    businessId: z.string().optional(),
  })
  .strict();
