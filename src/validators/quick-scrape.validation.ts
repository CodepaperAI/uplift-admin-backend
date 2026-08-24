import { z } from "zod";

const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const E164_PHONE_MESSAGE = "Enter a valid phone number including country code";

function normalizePhoneInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const REQUIRED_E164_PHONE = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string()
    .regex(
      E164_PHONE_PATTERN,
      "Phone number must include a valid country code, such as +14165550123",
    ),
);

export const OPTIONAL_E164_BUSINESS_PHONE = z.preprocess(
  normalizePhoneInput,
  z
    .string()
    .refine((value) => E164_PHONE_PATTERN.test(value), E164_PHONE_MESSAGE)
    .nullable()
    .optional(),
);

function isValidWebsiteUrl(value: string): boolean {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    const labels = parsed.hostname.split(".");
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      parsed.hostname.length <= 253 &&
      labels.length >= 2 &&
      labels.every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      )
    );
  } catch {
    return false;
  }
}

export const QUICK_BUSINESS_DETAILS = z.object({
  businessName: z.string().trim().optional().nullable(),
  businessType: z.string().trim().optional().nullable(),
  businessAddress: z.string().trim().optional().nullable(),
  businessCity: z.string().trim().optional().nullable(),
  businessState: z.string().trim().optional().nullable(),
  businessCountry: z.string().trim().optional().nullable(),
  businessPhone: OPTIONAL_E164_BUSINESS_PHONE,
  serviceArea: z.string().trim().optional().nullable(),
  serviceAreaLocations: z.array(z.string().trim()).optional().nullable(),
  businessLocationMode: z
    .enum(["physical", "service_area", "online_only", "unknown"])
    .optional()
    .nullable(),
  confirmedPlaceId: z.string().trim().optional().nullable(),
});

export const QUICK_SCRAPE = z.object({
  websiteUrl: z
    .string()
    .trim()
    .min(3, "Website URL is required")
    .max(2048, "Website URL is too long")
    .refine(
      isValidWebsiteUrl,
      "Enter a valid website URL, such as example.com",
    ),
});

export const SAVE_SERVICES = z.object({
  businessId: z.string().min(1, "Business ID is required"),
  selectedServices: z.array(z.string()),
  servicesPriority: z.record(z.string(), z.number()).optional(),
});

export const SAVE_BUSINESS_DETAILS = z.object({
  businessId: z.string().min(1, "Quick scrape business ID is required"),
  businessDetails: QUICK_BUSINESS_DETAILS,
});

export const SEARCH_QUICK_PLACES = z.object({
  businessId: z.string().min(1, "Quick scrape business ID is required"),
  query: z.string().trim().min(3, "Search query must be at least 3 characters"),
});

export const ONBOARDING_V2_STEPS = [
  "welcome",
  "website",
  "services",
  "brand",
  "questions",
  "contact",
  "author",
  "review",
  "preview",
  "payment",
  "complete",
] as const;

export const ONBOARDING_V2_STATUSES = [
  "in_progress",
  "preview_ready",
  "awaiting_payment",
  "completed",
] as const;

const ONBOARDING_V2_CLIENT_STATUSES = [
  "in_progress",
  "preview_ready",
  "awaiting_payment",
] as const;

const ONBOARDING_V2_BRAND_ASSET_URL = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Brand assets must use a valid HTTP or HTTPS URL");

const ONBOARDING_V2_BRAND = z
  .object({
    primaryColors: z
      .array(z.string().trim().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i))
      .max(4),
    secondaryColors: z
      .array(z.string().trim().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i))
      .max(6),
    fontFamily: z.string().trim().max(160),
    logoUrl: ONBOARDING_V2_BRAND_ASSET_URL,
    logoAltText: z.string().trim().max(300),
    faviconUrl: ONBOARDING_V2_BRAND_ASSET_URL,
    referenceImageUrl: ONBOARDING_V2_BRAND_ASSET_URL,
    slogan: z.string().trim().max(300),
  })
  .strict();

const singleAnswer = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(z.enum(values))
    .max(1)
    .transform((answers) => [...new Set(answers)]);

const multiAnswer = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(z.enum(values))
    .max(values.length)
    .transform((answers) => [...new Set(answers)]);

export const ONBOARDING_V2_ANSWERS = z
  .object({
    a3_voice: singleAnswer([
      "professional",
      "playful",
      "bold",
      "inspirational",
    ]).optional(),
    a2_audience: singleAnswer(["local", "business", "both", "online"]).optional(),
    a5_content: multiAnswer([
      "guides",
      "reviews",
      "news",
      "tutorials",
      "case-studies",
      "how-to",
    ]).optional(),
    a_reach: singleAnswer(["nearby", "regional", "national", "unsure"]).optional(),
    postsPerWeek: singleAnswer(["p3", "p5", "p7", "p10"]).optional(),
  })
  .strict();

export type OnboardingV2Answers = z.infer<typeof ONBOARDING_V2_ANSWERS>;

export function mergeOnboardingV2Answers(
  current: unknown,
  incoming: OnboardingV2Answers | undefined,
): { answers: Record<string, unknown>; changed: boolean } {
  const currentAnswers =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  if (!incoming) return { answers: currentAnswers, changed: false };
  const answers = { ...currentAnswers, ...incoming };
  return {
    answers,
    changed: JSON.stringify(currentAnswers) !== JSON.stringify(answers),
  };
}

const boundedNullableString = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .optional()
    .nullable();

export const ONBOARDING_V2_BUSINESS_DETAILS = z
  .object({
    businessName: boundedNullableString(160, "Business name"),
    businessType: boundedNullableString(160, "Business type"),
    businessAddress: boundedNullableString(500, "Business address"),
    businessCity: boundedNullableString(160, "Business city"),
    businessState: boundedNullableString(160, "Business state or province"),
    businessCountry: boundedNullableString(100, "Business country"),
    businessPhone: OPTIONAL_E164_BUSINESS_PHONE,
    serviceArea: boundedNullableString(200, "Service area"),
    serviceAreaLocations: z
      .array(z.string().trim().min(1).max(160))
      .max(25)
      .optional()
      .nullable(),
    businessLocationMode: z
      .enum(["physical", "service_area", "online_only", "unknown"])
      .optional()
      .nullable(),
    confirmedPlaceId: boundedNullableString(255, "Confirmed place ID"),
  })
  .strict();

export const ONBOARDING_V2_AUTHOR = z
  .object({
    name: z
      .string()
      .trim()
      .max(160, "Author name must be 160 characters or fewer")
      .optional(),
    title: z
      .string()
      .trim()
      .max(160, "Author title must be 160 characters or fewer")
      .optional(),
    bio: z
      .string()
      .trim()
      .max(2_000, "Author bio must be 2000 characters or fewer")
      .optional(),
    expertise: z
      .array(
        z
          .string()
          .trim()
          .min(1, "Area of expertise cannot be blank")
          .max(160, "Area of expertise must be 160 characters or fewer"),
      )
      .max(25, "Add no more than 25 areas of expertise")
      .optional()
      .transform((values) => (values ? [...new Set(values)] : values)),
  })
  .strict();

export type OnboardingV2Author = z.infer<typeof ONBOARDING_V2_AUTHOR>;

export function mergeOnboardingV2Author(
  current: unknown,
  incoming: Partial<OnboardingV2Author> | undefined,
): Record<string, unknown> {
  const currentAuthor =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return incoming ? { ...currentAuthor, ...incoming } : currentAuthor;
}

export const UPLOAD_ONBOARDING_V2_AUTHOR_IMAGE = z
  .object({
    businessId: z.string().uuid(),
  })
  .strict();

export const UPLOAD_ONBOARDING_V2_BRAND_LOGO = z
  .object({
    businessId: z.string().uuid(),
  })
  .strict();

export const GET_ONBOARDING_V2_STATE = z
  .object({
    businessId: z.string().uuid().optional(),
  })
  .strict();

export const PATCH_ONBOARDING_V2_STATE = z
  .object({
    businessId: z.string().uuid(),
    step: z.enum(ONBOARDING_V2_STEPS).optional(),
    questionIndex: z.number().int().min(0).max(5).optional(),
    answers: ONBOARDING_V2_ANSWERS.optional(),
    status: z.enum(ONBOARDING_V2_CLIENT_STATUSES).optional(),
    businessDetails: ONBOARDING_V2_BUSINESS_DETAILS.optional(),
    selectedServices: z
      .array(z.string().trim().min(1).max(200))
      .max(25)
      .optional()
      .transform((values) => (values ? [...new Set(values)] : values)),
    servicesPriority: z.record(z.string(), z.number().int().min(1).max(25)).optional(),
    brand: ONBOARDING_V2_BRAND.optional(),
    author: ONBOARDING_V2_AUTHOR.optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "businessId"),
    "At least one onboarding field is required",
  );

export const START_ONBOARDING_V2_GENERATION = z
  .object({
    businessId: z.string().uuid(),
  })
  .strict();

export const BEGIN_SECONDARY_ONBOARDING_V2 = QUICK_SCRAPE.pick({
  websiteUrl: true,
}).strict();

export const COMPLETE_SECONDARY_ONBOARDING_V2 = z
  .object({
    quickScrapeBusinessId: z.string().uuid(),
  })
  .strict();

export const CONFIRM_SECONDARY_DETAILS = z.object({
  businessId: z.string().optional(),
  websiteUrl: z.string().trim().url().optional(),
  businessName: z.string().trim().min(1),
  businessAddress: z.string().trim().min(1),
  businessCity: z.string().trim().min(1),
  businessState: z.string().trim().min(1),
  businessCountry: z.string().trim().min(1),
  businessPhone: OPTIONAL_E164_BUSINESS_PHONE,
});

export const GET_ONBOARDING_V2_PREVIEW = GET_ONBOARDING_V2_STATE.required({
  businessId: true,
});
