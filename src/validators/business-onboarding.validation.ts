import { z } from "zod";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";

const boundedOptionalString = (max: number, label: string) =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer`).optional();

export const UPDATE_BUSINESS_LOCATION = z.object({
  businessId: z.string().max(100).optional(),
  businessAddress: boundedOptionalString(USER_INPUT_LIMITS.address, "Business address"),
  businessCity: boundedOptionalString(USER_INPUT_LIMITS.locationName, "Business city"),
  businessState: boundedOptionalString(USER_INPUT_LIMITS.locationName, "Business state or province"),
  businessCountry: boundedOptionalString(USER_INPUT_LIMITS.country, "Business country"),
  serviceArea: boundedOptionalString(USER_INPUT_LIMITS.serviceArea, "Service area"),
  serviceAreaLocations: z
    .array(z.string().trim().min(1).max(USER_INPUT_LIMITS.serviceAreaLocation))
    .max(USER_INPUT_LIMITS.serviceAreaLocations, "Maximum 10 service area locations allowed")
    .optional(),
});

export const UPDATE_BUSINESS_PREFERENCES = z.object({
  businessId: z.string().max(100).optional(),
  targetAudience: boundedOptionalString(USER_INPUT_LIMITS.targetAudience, "Target audience"),
  contentTone: boundedOptionalString(USER_INPUT_LIMITS.locationName, "Content tone"),
  publishingFrequency: boundedOptionalString(USER_INPUT_LIMITS.locationName, "Publishing frequency"),
  publishDaysOfWeek: z.array(z.number().min(0).max(6)).optional(),
  preferredContentTypes: z
    .array(z.string().trim().min(1).max(USER_INPUT_LIMITS.locationName))
    .max(25)
    .optional(),
  defaultLocale: boundedOptionalString(35, "Default locale"),
});

export const UPDATE_BUSINESS_BLOG_URLS = z.object({
  businessId: z.string().max(100).optional(),
  blogUrls: z
    .array(
      z
        .string()
        .trim()
        .max(USER_INPUT_LIMITS.url, "Each blog URL must be 2048 characters or fewer")
        .url("Each blog URL must be a valid URL"),
    )
    .max(5, "Maximum 5 blog URLs allowed"),
});

export const UPDATE_BUSINESS_AUTHOR_PROFILE = z.object({
  businessId: z.string().max(100).optional(),
  authorName: z
    .string()
    .trim()
    .min(1, "Author name is required")
    .max(USER_INPUT_LIMITS.authorName),
  authorBio: boundedOptionalString(USER_INPUT_LIMITS.authorBio, "Author bio"),
  authorJobTitle: boundedOptionalString(USER_INPUT_LIMITS.authorTitle, "Author job title"),
  authorImage: z
    .string()
    .max(USER_INPUT_LIMITS.url)
    .url()
    .optional()
    .or(z.literal("")),
  authorExpertise: z
    .array(z.string().trim().min(1).max(USER_INPUT_LIMITS.authorExpertise))
    .max(USER_INPUT_LIMITS.authorExpertiseItems)
    .optional(),
  authorSocialLinks: z.object({
    linkedin: boundedOptionalString(USER_INPUT_LIMITS.url, "LinkedIn URL"),
    twitter: boundedOptionalString(USER_INPUT_LIMITS.url, "X URL"),
    facebook: boundedOptionalString(USER_INPUT_LIMITS.url, "Facebook URL"),
    website: boundedOptionalString(USER_INPUT_LIMITS.url, "Author website URL"),
  }).optional(),
});
