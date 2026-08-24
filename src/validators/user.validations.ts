import z from "zod";

export const ONBOARDING = z
  .object({
    userId: z.string(),
  })
  .strict();

export const ONBOARDING_WITH_WEBSITE = z
  .object({
    userId: z.string().min(1, "User ID is required"),
    websiteUrl: z.string().url("Valid website URL is required"),
  })
  .strict();
