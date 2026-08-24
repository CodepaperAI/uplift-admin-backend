import { z } from "zod";
import {
  QUICK_BUSINESS_DETAILS,
  REQUIRED_E164_PHONE,
} from "./quick-scrape.validation";

export const ENROLL_TRIAL = z
  .object({
    userId: z.string().min(1, "User ID is required").optional(),
    phone: REQUIRED_E164_PHONE,
    businessId: z.string().min(1, "Quick scrape business ID is required"),
    businessDetails: QUICK_BUSINESS_DETAILS.optional(),
  });

export const CHECK_TRIAL_STATUS = z.object({
  userId: z.string().min(1, "User ID is required").optional(),
});

export const TRIGGER_COMPLETE_ONBOARDING = z.object({
  userId: z.string().min(1, "User ID is required").optional(),
  businessId: z.string().min(1, "Quick scrape business ID is required"),
  businessDetails: QUICK_BUSINESS_DETAILS.optional(),
});
