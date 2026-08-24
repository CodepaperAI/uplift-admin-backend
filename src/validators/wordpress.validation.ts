import z from "zod";

export const addWordPressCredentialsValidation = z.object({
  websiteUrl: z.string().trim().url().max(2048),
  username: z.string().trim().min(1).max(160),
  app_password: z.string().trim().min(8).max(512),
}).strict();
