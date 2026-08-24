import { ConnectionPlatform, PublishAs } from "@prisma/client";

export interface PublishResult {
  success: boolean;
  postId?: string;
  postUrl?: string;
  status?: string;
  error?: string;
  message?: string;
  platformResponse?: any;
  inProgress?: boolean;
}

export interface BlogPublishData {
  id: string;
  title: string;
  content: string;
  excerpt: string;
  slug: string;
  featured_media?: string;
  status: string;
  userId: string;
  blogPublishDate?: string;
  blogPublishTime?: string;
  meta?: {
    seo_title: string;
    seo_description: string;
    focus_keyword?: string;
    keywords?: string[];
    og_title?: string;
    og_description?: string;
    og_type?: string;
    og_url?: string;
    og_site_name?: string;
    og_locale?: string;
    article_author?: string;
    article_section?: string;
    article_tags?: string[];
  };
  custom_fields?: {
    reading_time?: string;
    rating?: number;
  };
  categories?: string[];
  tags?: string[];
  attemptId?: string;
  forceUpdate?: boolean;
  externalPostId?: string;
}

export interface PublishingIntegrationData {
  id: string;
  userId: string;
  platform: ConnectionPlatform;
  isActive: boolean;
  autoPublish: boolean;
  publishAs: PublishAs;

  // WordPress
  wordpressUrl?: string | null;
  wordpressUsername?: string | null;
  wordpressPassword?: string | null;
  wordpressConnectionMethod?: string | null;
  wordpressOAuthTokenId?: string | null;
  wordpressIntegrationKey?: string | null;

  // Webflow (backward compatibility - API Key)
  webflowSiteId?: string | null;
  webflowApiKey?: string | null;
  webflowCollectionId?: string | null;
  // Webflow OAuth (NEW)
  webflowConnectionMethod?: string | null; // "API_KEY" | "OAUTH"
  webflowOAuthTokenId?: string | null;

  // Shopify (backward compatibility - API Key)
  shopifyShopDomain?: string | null;
  shopifyAccessToken?: string | null;
  shopifyClientId?: string | null;
  shopifyClientSecret?: string | null;
  shopifyAccessTokenIssuedAt?: Date | null;
  shopifyAccessTokenExpiresAt?: Date | null;
  shopifyApiVersion?: string | null;
  shopifyBlogId?: string | null;
  // Shopify App OAuth (NEW)
  shopifyConnectionMethod?: string | null; // "API_KEY" | "OAUTH" | "CUSTOM_APP"
  shopifyOAuthTokenId?: string | null;
  shopifyApiMethod?: string | null; // "REST" | "GRAPHQL"

  // Framer
  framerProjectId?: string | null;
  framerApiKey?: string | null;
  framerCollectionName?: string | null;

  // Custom API
  customApiUrl?: string | null;
  customApiKey?: string | null;
  customApiSecret?: string | null;
  customApiMethod?: string | null;
  customApiAuthType?: string | null;
  customApiHeaders?: any;
  customApiPayloadMapping?: any;
  customApiResponseMapping?: any;

  // Wix OAuth (Wix requires OAuth 2.0)
  wixSiteId?: string | null;
  wixConnectionMethod?: string | null; // "OAUTH" only
  wixOAuthTokenId?: string | null;
  wixCollectionId?: string | null;

  // Reddit OAuth
  redditOAuthTokenId?: string | null;
  redditSubreddit?: string | null;

  // Medium OAuth
  mediumOAuthTokenId?: string | null;
  mediumPublicationId?: string | null;
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}
