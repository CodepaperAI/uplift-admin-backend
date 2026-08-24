import { z } from "zod";
import { INTERNAL_GMB_POST_TYPES } from "../utils/google-my-business-local-post.utils";

const LEGACY_USER_ID = z.string().min(1, "User ID is required").optional();
const BUSINESS_ID = z.string().min(1, "Business ID is required");
const PUBLISHING_MODE = z.enum(["approval_required", "auto_publish", "disabled"]);
const EDIT_MODE = z.enum(["approval_required", "disabled"]);
const RANK_SCAN_CADENCE = z.enum(["manual", "weekly", "monthly"]);
const GMB_SERVICE_ITEM = z.union([
  z.string().min(1),
  z
    .object({
      displayName: z.string().min(1).max(140),
      description: z.string().max(250).optional(),
    })
    .passthrough(),
  z
    .object({
      name: z.string().min(1).max(140),
      description: z.string().max(250).optional(),
    })
    .passthrough(),
  z
    .object({
      freeFormServiceItem: z.object({}).passthrough(),
    })
    .passthrough(),
  z
    .object({
      structuredServiceItem: z.object({}).passthrough(),
    })
    .passthrough(),
]);

export const CONNECT_GMB = z.object({
  code: z.string().min(1, "Authorization code is required"),
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  redirectUri: z.string().url("OAuth redirect URI must be a valid URL"),
});

export const GET_GMB_ACCOUNTS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
});

export const GET_GMB_LOCATIONS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  accountId: z.string().min(1, "Account ID is required"),
});

export const CREATE_GMB_POST = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  locationId: z.string().min(1, "Location ID is required").optional(),
  postType: z.enum(INTERNAL_GMB_POST_TYPES),
  summary: z
    .string()
    .min(1, "Post summary is required")
    .max(1500, "Summary must be less than 1500 characters"),
  title: z.string().optional(),
  callToAction: z
    .string()
    .url("Destination URL must be a valid absolute URL")
    .optional(),
  mediaUrls: z.array(z.string().url("Media URL must be valid")).optional(),
});

export const GET_GMB_REVIEWS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  locationId: z.string().min(1, "Location ID is required").optional(),
});

export const RESPOND_TO_REVIEW = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  reviewId: z.string().min(1, "Review ID is required"),
  response: z
    .string()
    .min(1, "Response is required")
    .max(3500, "Response must be less than 3500 characters"),
});

export const GET_GMB_INSIGHTS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  locationId: z.string().min(1, "Location ID is required").optional(),
});

export const UPDATE_BUSINESS_INFO = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  locationId: z.string().min(1, "Location ID is required").optional(),
  businessData: z.object({
    name: z.string().optional(),
    address: z.string().optional(),
    phoneNumber: z.string().optional(),
    websiteUrl: z.string().url().optional(),
    businessHours: z
      .object({
        dayOfWeek: z.enum([
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
          "SUNDAY",
        ]),
        openTime: z.string().optional(),
        closeTime: z.string().optional(),
        isClosed: z.boolean().optional(),
      })
      .array()
      .optional(),
    categories: z.array(z.string().min(1)).optional(),
    serviceItems: z.array(GMB_SERVICE_ITEM).optional(),
    description: z
      .string()
      .max(750, "Description exceeds Google's 750-character limit")
      .optional(),
  }),
});

export const GET_GMB_POSTS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  locationId: z.string().min(1, "Location ID is required").optional(),
});

export const DISCONNECT_GMB = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
});

export const GMB_BUSINESS_SCOPED = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
});

export const GMB_DEMO_MODE = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
});

export const GMB_AI_SUGGESTIONS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceRefresh: z.boolean().optional().default(false),
});

export const SELECT_GMB_LOCATION = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  accountId: z.string().min(1, "Account ID is required"),
  accountName: z.string().min(1, "Account name is required"),
  locationId: z.string().min(1, "Location ID is required"),
  locationName: z.string().min(1, "Location name is required"),
  address: z.string().optional().nullable(),
});

export const SYNC_GMB = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceSync: z.boolean().optional(),
});

export const GENERATE_REVIEW_RESPONSE = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  reviewerName: z.string().min(1, "Reviewer name is required"),
  rating: z.number().min(1).max(5),
  comment: z.string().nullable(),
  businessType: z.string().optional(),
  reviewId: z.string().optional(),
  forceRefresh: z.boolean().optional().default(false),
});

export const GMB_POST_SUGGESTIONS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceRefresh: z.boolean().optional().default(false),
  generateImages: z.boolean().optional().default(true),
});

export const GMB_REVIEW_ANALYSIS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceRefresh: z.boolean().optional().default(false),
});

export const UPDATE_GMB_SETTINGS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  autoPostToGmbEnabled: z.boolean().optional(),
  autoReviewReplyEnabled: z.boolean().optional(),
  postAutomationMode: PUBLISHING_MODE.optional(),
  reviewReplyMode: PUBLISHING_MODE.optional(),
  profileEditMode: EDIT_MODE.optional(),
  mediaPublishingMode: PUBLISHING_MODE.optional(),
  rankScanCadence: RANK_SCAN_CADENCE.optional(),
  notificationPreferences: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const SCHEDULE_POST_SUGGESTION = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  suggestionId: z.string().min(1, "Suggestion ID is required"),
  scheduledAt: z.string().datetime("Invalid datetime format"),
});

export const DISMISS_POST_SUGGESTION = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  suggestionId: z.string().min(1, "Suggestion ID is required"),
});

export const PUBLISH_POST_SUGGESTION = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  suggestionId: z.string().min(1, "Suggestion ID is required"),
});

export const GMB_PROFILE_HEALTH = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceRefresh: z.boolean().optional().default(false),
});

export const GMB_DISCOVERY_KEYWORDS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceRefresh: z.boolean().optional().default(false),
  months: z.number().int().min(1).max(18).optional().default(3),
});

export const GMB_METRICS_TIMESERIES = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  forceRefresh: z.boolean().optional().default(false),
  days: z.number().int().min(1).max(180).optional().default(90),
});

export const GMB_ACTIONS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  status: z
    .enum(["PENDING", "APPROVED", "DISMISSED", "APPLIED", "FAILED"])
    .optional(),
});

export const GMB_ACTION_MUTATION = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  actionId: z.string().min(1, "Action ID is required"),
});

export const GMB_MEDIA = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  sourceUrl: z
    .string()
    .url("Media URL must be valid")
    .startsWith("https://", "Media URL must use https://")
    .optional(),
  category: z
    .enum([
      "COVER",
      "PROFILE",
      "LOGO",
      "EXTERIOR",
      "INTERIOR",
      "PRODUCT",
      "AT_WORK",
      "FOOD_AND_DRINK",
      "MENU",
      "COMMON_AREA",
      "ROOMS",
      "TEAMS",
      "ADDITIONAL",
      "OTHER",
    ])
    .optional(),
  caption: z.string().max(500).optional(),
});

export const GMB_RANK_SCANS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  runScan: z.boolean().optional().default(false),
  keywords: z.array(z.string().min(1)).max(20).optional(),
  locationCode: z.number().int().positive().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

export const GMB_REVIEW_CAMPAIGNS = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
});

export const GMB_REVIEW_CAMPAIGN_IMPORT = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  campaignId: z.string().min(1),
  contacts: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export const GMB_REVIEW_CAMPAIGN_ACTIVATE = z.object({
  userId: LEGACY_USER_ID,
  businessId: BUSINESS_ID,
  campaignId: z.string().min(1),
  action: z.enum(["activate", "pause"]),
});
