import { ConnectionPlatform, PublishAs, PublishStatus } from "@prisma/client";
import { z } from "zod";

const boundedRecord = z
  .record(z.string().max(64), z.unknown())
  .refine((value) => Object.keys(value).length <= 100, "Too many mapping fields")
  .refine((value) => JSON.stringify(value).length <= 20_000, "Mapping is too large");

const customHeaders = z
  .record(z.string().max(64), z.string().max(2048))
  .refine((value) => Object.keys(value).length <= 30, "Too many custom headers");

export const CONNECT_PUBLISHING_INTEGRATION = z.object({
  businessId: z.string().uuid(),
  platform: z.nativeEnum(ConnectionPlatform),
  connectionName: z.string().trim().max(160).optional(),
  autoPublish: z.boolean().optional().default(true),
  publishAs: z.nativeEnum(PublishAs).optional().default(PublishAs.PUBLISH),

  // WordPress
  wordpressUrl: z.string().trim().url().max(2048).optional(),
  wordpressUsername: z.string().trim().max(160).optional(),
  wordpressPassword: z.string().max(512).optional(),

  // Webflow
  webflowSiteId: z.string().trim().max(160).optional(),
  webflowApiKey: z.string().trim().max(2048).optional(),
  webflowCollectionId: z.string().trim().max(160).optional(),
  webflowConnectionMethod: z.enum(["API_KEY", "OAUTH"]).optional(),

  // Shopify
  shopifyShopDomain: z.string().trim().max(255).optional(),
  shopifyAccessToken: z.string().trim().max(2048).optional(),
  shopifyClientId: z.string().trim().max(512).optional(),
  shopifyClientSecret: z.string().max(2048).optional(),
  shopifyApiVersion: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).optional().default("2026-01"),
  shopifyBlogId: z.string().trim().max(160).optional(),
  shopifyApiMethod: z.enum(["REST", "GRAPHQL"]).optional().default("REST"),
  shopifyConnectionMethod: z
    .enum(["API_KEY", "OAUTH", "CUSTOM_APP"])
    .optional(),

  // Framer
  framerProjectId: z.string().trim().max(255).optional(),
  framerApiKey: z.string().trim().max(2048).optional(),
  framerCollectionName: z.string().trim().max(255).optional(),

  // Custom API
  customApiUrl: z.string().trim().url().max(2048).optional(),
  customApiKey: z.string().max(4096).optional(),
  customApiSecret: z.string().max(4096).optional(),
  customApiMethod: z.enum(["POST", "PUT", "PATCH"]).optional().default("POST"),
  customApiAuthType: z
    .enum(["bearer", "basic", "apikey", "oauth"])
    .optional()
    .default("bearer"),

  customApiHeaders: customHeaders.optional(),
  customApiPayloadMapping: boundedRecord.optional(),
  customApiResponseMapping: z
    .record(z.string().max(64), z.string().max(255))
    .refine((value) => Object.keys(value).length <= 20, "Too many response mappings")
    .optional(),

  // Wix OAuth (Wix requires OAuth 2.0)
  wixSiteId: z.string().trim().max(255).optional(),
  wixCollectionId: z.string().trim().max(255).optional(),

  // Reddit OAuth
  redditSubreddit: z.string().trim().regex(/^[A-Za-z0-9_]{2,21}$/).optional(),

  // Medium OAuth
  mediumPublicationId: z.string().trim().max(255).optional(),
}).strict();

export const UPDATE_PUBLISHING_INTEGRATION =
  CONNECT_PUBLISHING_INTEGRATION.partial();

export const PUBLISH_BLOG = z.object({
  businessId: z.string().uuid(),
  blogId: z.string().uuid(),
  integrationId: z.string().uuid().optional(),
  platform: z.nativeEnum(ConnectionPlatform).optional(),
  forceUpdate: z.boolean().optional(),
}).strict();

export const TEST_CONNECTION = z.object({
  integrationId: z.string().uuid(),
}).strict();

export const GET_PUBLISHED_BLOGS = z.object({
  businessId: z.string().uuid().optional(),
  blogId: z.string().uuid().optional(),
  platform: z.nativeEnum(ConnectionPlatform).optional(),
  status: z.nativeEnum(PublishStatus).optional(),
}).strict();
