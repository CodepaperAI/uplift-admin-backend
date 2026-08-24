import z from "zod";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";

const boundedOptionalString = (max: number) =>
  z.string().trim().max(max).optional();
const boundedUrl = z.string().trim().max(USER_INPUT_LIMITS.url).url();
const boundedKeywordArray = z
  .array(z.string().trim().min(1).max(USER_INPUT_LIMITS.keyword))
  .max(25);

const OPTIONAL_DATE_STRING = z
  .string()
  .refine((value) => value === "" || !Number.isNaN(Date.parse(value)), {
    message: "Invalid date",
  })
  .optional()
  .or(z.literal(""));

// ============================================
// Publisher Validations
// ============================================

export const CREATE_PUBLISHER = z.object({
  name: z.string().trim().min(1, "Publisher name is required").max(USER_INPUT_LIMITS.businessName),
  websiteUrl: boundedUrl,
  niche: boundedOptionalString(USER_INPUT_LIMITS.locationName),
  contactEmail: z
    .string()
    .trim()
    .max(320)
    .email("Invalid email")
    .optional()
    .or(z.literal("")),
  contactName: boundedOptionalString(USER_INPUT_LIMITS.locationName),
  submissionUrl: boundedUrl.optional().or(z.literal("")),
  submissionGuidelines: boundedOptionalString(USER_INPUT_LIMITS.genericTextarea),
  acceptedFormats: z.array(z.string().trim().min(1).max(160)).max(25).optional(),
  minWordCount: z.number().int().positive().optional(),
  maxWordCount: z.number().int().positive().optional(),
  requiresPayment: z.boolean().optional(),
  priceRange: boundedOptionalString(160),
  acceptsLinks: z.boolean().optional(),
  maxLinksPerPost: z.number().int().positive().optional(),
  linkTypesAllowed: z.array(z.string().trim().min(1).max(160)).max(25).optional(),
  responseTime: boundedOptionalString(160),
  notes: boundedOptionalString(USER_INPUT_LIMITS.notes),
});

export const UPDATE_PUBLISHER = CREATE_PUBLISHER.partial().extend({
  isActive: z.boolean().optional(),
  acceptanceRate: z.number().min(0).max(1).optional(),
});

export const GET_PUBLISHERS = z.object({
  userId: z.string(),
  niche: z.string().optional(),
  minDomainAuthority: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  source: z.string().optional(),
  isSuggested: z.boolean().optional(), // Filter by suggested status
});

export const GET_PUBLISHER_BY_ID = z.object({
  userId: z.string(),
  publisherId: z.string(),
});

export const DELETE_PUBLISHER = z.object({
  userId: z.string(),
  publisherId: z.string(),
});

export const ENRICH_PUBLISHER_METRICS = z.object({
  userId: z.string(),
  publisherId: z.string(),
});

// ============================================
// Campaign Validations
// ============================================

export const CREATE_CAMPAIGN = z.object({
  userId: z.string(),
  businessId: z.string(),
  name: z.string().trim().min(1, "Campaign name is required").max(USER_INPUT_LIMITS.businessName),
  description: boundedOptionalString(USER_INPUT_LIMITS.description),
  targetKeywords: boundedKeywordArray.optional(),
  targetNiche: boundedOptionalString(USER_INPUT_LIMITS.locationName),
  minDomainAuthority: z.number().int().min(0).max(100).optional(),
  maxPublisherSpamScore: z.number().int().min(0).max(100).optional(),
  maxBudget: z.number().positive().optional(),
  targetLinks: z.number().int().positive().default(10),
  campaignTemplate: z
    .enum(["STANDARD", "HIGH_DR_GUEST_POSTING"])
    .optional()
    .default("HIGH_DR_GUEST_POSTING"),
  startDate: OPTIONAL_DATE_STRING,
  endDate: OPTIONAL_DATE_STRING,
  autoCreateSubmissions: z.boolean().optional().default(false),
  autoGeneratePitch: z.boolean().optional().default(true),
  autoSendPitch: z.boolean().optional().default(false),
  autoApprovePublishers: z.boolean().optional().default(false),
  autoPitchDelayHours: z.number().int().min(0).max(168).optional(),
  maxSubmissionsPerDay: z.number().int().min(1).max(50).optional().default(3),
  requireNicheMatch: z.boolean().optional().default(true),
  requireVerifiedPublishers: z.boolean().optional().default(true),
});

export const UPDATE_CAMPAIGN = z.object({
  userId: z.string(),
  campaignId: z.string(),
  name: z.string().trim().min(1).max(USER_INPUT_LIMITS.businessName).optional(),
  description: boundedOptionalString(USER_INPUT_LIMITS.description),
  targetKeywords: boundedKeywordArray.optional(),
  targetNiche: boundedOptionalString(USER_INPUT_LIMITS.locationName),
  minDomainAuthority: z.number().int().min(0).max(100).optional(),
  maxPublisherSpamScore: z.number().int().min(0).max(100).optional(),
  maxBudget: z.number().positive().optional(),
  targetLinks: z.number().int().positive().optional(),
  campaignTemplate: z.enum(["STANDARD", "HIGH_DR_GUEST_POSTING"]).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"]).optional(),
  startDate: OPTIONAL_DATE_STRING,
  endDate: OPTIONAL_DATE_STRING,
  autoCreateSubmissions: z.boolean().optional(),
  autoGeneratePitch: z.boolean().optional(),
  autoSendPitch: z.boolean().optional(),
  autoApprovePublishers: z.boolean().optional(),
  autoPitchDelayHours: z.number().int().min(0).max(168).optional(),
  maxSubmissionsPerDay: z.number().int().min(1).max(50).optional(),
  requireNicheMatch: z.boolean().optional(),
  requireVerifiedPublishers: z.boolean().optional(),
});

export const GET_CAMPAIGNS = z.object({
  userId: z.string(),
  businessId: z.string().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"]).optional(),
});

export const GET_CAMPAIGN_BY_ID = z.object({
  userId: z.string(),
  campaignId: z.string(),
});

export const DELETE_CAMPAIGN = z.object({
  userId: z.string(),
  campaignId: z.string(),
});

export const GET_CAMPAIGN_ANALYTICS = z.object({
  userId: z.string(),
  campaignId: z.string(),
});

// ============================================
// Submission Validations
// ============================================

export const CREATE_SUBMISSION = z.object({
  userId: z.string(),
  campaignId: z.string().optional(),
  publisherId: z.string().min(1, "Publisher ID is required"),
  blogId: z.string().optional(),
  title: z.string().trim().min(1, "Title is required").max(300),
  proposedTopic: boundedOptionalString(USER_INPUT_LIMITS.description),
  pitchEmail: boundedOptionalString(USER_INPUT_LIMITS.longFormContent),
  customContent: boundedOptionalString(USER_INPUT_LIMITS.longFormContent),
  cost: z.number().positive().optional(),
  currency: z.string().trim().min(3).max(3).default("USD"),
  internalNotes: boundedOptionalString(USER_INPUT_LIMITS.notes),
});

export const UPDATE_SUBMISSION = z.object({
  userId: z.string(),
  submissionId: z.string(),
  title: z.string().trim().min(1).max(300).optional(),
  proposedTopic: boundedOptionalString(USER_INPUT_LIMITS.description),
  pitchEmail: boundedOptionalString(USER_INPUT_LIMITS.longFormContent),
  customContent: boundedOptionalString(USER_INPUT_LIMITS.longFormContent),
  cost: z.number().positive().optional(),
  currency: z.string().trim().min(3).max(3).optional(),
  internalNotes: boundedOptionalString(USER_INPUT_LIMITS.notes),
});

export const UPDATE_SUBMISSION_STATUS = z.object({
  userId: z.string(),
  submissionId: z.string(),
  status: z.enum([
    "DRAFT",
    "PITCHED",
    "ACCEPTED",
    "REJECTED",
    "PUBLISHED",
    "EXPIRED",
  ]),
  publishedUrl: boundedUrl.optional().or(z.literal("")),
  publishedTitle: boundedOptionalString(300),
  backlinksReceived: z.array(boundedUrl).max(100).optional(),
  rejectionReason: boundedOptionalString(USER_INPUT_LIMITS.description),
});

export const GET_SUBMISSIONS = z.object({
  userId: z.string(),
  campaignId: z.string().optional(),
  publisherId: z.string().optional(),
  status: z
    .enum(["DRAFT", "PITCHED", "ACCEPTED", "REJECTED", "PUBLISHED", "EXPIRED"])
    .optional(),
  blogId: z.string().optional(),
});

export const GET_SUBMISSION_BY_ID = z.object({
  userId: z.string(),
  submissionId: z.string(),
});

export const DELETE_SUBMISSION = z.object({
  userId: z.string(),
  submissionId: z.string(),
});

// ============================================
// Analytics Validations
// ============================================

export const GET_PUBLISHER_PERFORMANCE = z.object({
  userId: z.string(),
  publisherId: z.string(),
});
