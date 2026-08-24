export const SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "x",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type SocialCreativePreferredImageSize =
  | "1024x1280"
  | "1216x640"
  | "1280x720"
  // Retained for already-enqueued records created before the platform-spec
  // update. New website-campaign assets use the three exact sizes above.
  | "1024x1536"
  | "1536x1024";
export type SocialCreativeProviderImageSize = `${number}x${number}`;
export type SocialCreativeImageRequestSize =
  SocialCreativePreferredImageSize | "auto";
export type SocialPackKind = "single" | "carousel";
export type SocialCreativeSource =
  "MANUAL" | "BLOG" | "SCHEDULE" | "ONBOARDING";

export type SocialCreativeStatus =
  "PENDING" | "PLANNING" | "RENDERING" | "COMPLETE" | "FAILED" | "CANCELLED";

export type SocialCreativeFormat = {
  platform: SocialPlatform;
  placement: string;
  aspectRatio: string;
  width: number;
  height: number;
  sourceSize: SocialCreativePreferredImageSize;
};

export type SocialCreativeCopy = {
  headline: string;
  supportingLine: string;
  cta: string;
  caption: string;
};

export type SocialCreativeSlidePlan = SocialCreativeCopy & {
  slideIndex: number;
  topic: string;
  visualConcept: string;
  campaignObjective: string;
  archetype: string;
  layoutFamily: string;
};

export type SocialCreativePlan = {
  language: string;
  locale: string;
  topic: string;
  slides: SocialCreativeSlidePlan[];
  artworkLogoIncluded?: boolean;
  brandLogoUrl?: string;
  brandReferences?: SocialCreativeImageReference[];
  platformCopy?: Partial<
    Record<SocialPlatform, { caption: string; hashtags: string[] }>
  >;
  platformCopyVariants?: Partial<
    Record<
      SocialPlatform,
      Array<{
        slot: string;
        caption: string;
        hashtags: string[];
      }>
    >
  >;
  platformCopySource?: "gpt-5.6-luna" | "mixed" | "deterministic-fallback";
  platformCopyVersion?: string;
  carouselCreativeDirection?: string;
  carouselPlanVersion?: string;
};

export type SocialCreativeImageReference = {
  url: string;
  role: "logo" | "subject" | "style-layout";
  description?: string;
};

export type SocialCreativePositiveReview = {
  excerpt: string;
  rating: 4 | 5;
  reviewedAt: string;
  source: "google-business-profile";
};

export type SocialCreativePromotionInput = {
  enabled: boolean;
  title: string | null;
  information: string | null;
  preferredContent: string | null;
  startsOn: string | null;
  endsOn: string | null;
  imageUrl: string | null;
  documentName: string | null;
  documentText: string | null;
};

export type SocialCreativePromotion = {
  enabled: true;
  title: string;
  information: string;
  preferredContent: string | null;
  startsOn: string;
  endsOn: string;
  imageUrl: string | null;
  documentName: string | null;
  documentText: string | null;
};

export type SocialCreativeBrandContext = {
  userId: string;
  businessId: string;
  businessName: string;
  businessType: string;
  businessDescription: string;
  websiteUrl: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  language: string;
  locale: string;
  tone: string;
  targetAudience: string | null;
  services: string[];
  primaryColors: string[];
  secondaryColors: string[];
  fontFamily: string | null;
  logoUrl: string | null;
  referenceImageUrls: string[];
  recentCreativeHistory: Array<{
    headline: string;
    archetype: string | null;
    layoutFamily: string | null;
  }>;
  tagline?: string | null;
  brandVoice?: string | null;
  keyMessages?: string[];
  socialContentAngles?: string[];
  serviceAreas?: string[];
  differentiators?: string[];
  customerPainPoints?: string[];
  verifiedActions?: Array<{
    type: "website" | "phone" | "booking" | "contact";
    label: string;
    value: string;
  }>;
  verifiedProof?: {
    averageRating: number;
    reviewCount: number;
  } | null;
  recentPositiveReviews?: SocialCreativePositiveReview[];
  promotion?: SocialCreativePromotionInput | null;
  creativeReferenceImages?: Array<{
    id: string;
    url: string;
    scope: "ALWAYS" | "PROMOTION";
  }>;
  referenceImages?: Array<{
    id: string;
    url: string;
    role: "subject" | "style-layout";
    description: string;
    provenance: "brand-analysis" | "business-photo";
  }>;
};

export type SocialCreativeImageResult = {
  buffer: Buffer;
  model: string;
  quality: string | null;
  sourceSize: SocialCreativeProviderImageSize;
  providerRequestId: string;
  sha256: string;
  estimatedUsd: number;
  actualUsd: number | null;
  pricingVersion: string;
  usage: {
    inputTokens: number;
    inputTextTokens: number;
    inputImageTokens: number;
    outputTokens: number;
    outputImageTokens: number;
    totalTokens: number;
  } | null;
  requested?: {
    quality: string | null;
    sourceSize: SocialCreativeImageRequestSize;
    targetSize?: SocialCreativePreferredImageSize;
    outputFormat: string | null;
    requestMode?: "generation" | "reference-edit";
    referenceImageCount?: number;
  };
  returned?: {
    outputFormat: string;
    mimeType: string;
    width: number;
    height: number;
    source: "base64" | "url";
  };
};

export type SocialCreativeCompositionDiagnostics = {
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  layoutFamily: string;
  headlineLines: string[];
  supportingLines: string[];
  renderedCopy: SocialCreativeCopy;
  logoApplied: boolean;
  safeMarginPx: number;
};

export type SocialCreativeComposedAsset = {
  buffer: Buffer;
  diagnostics: SocialCreativeCompositionDiagnostics;
};

export type SocialCreativeQualityResult = {
  ok: boolean;
  width: number;
  height: number;
  bytes: number;
  format: string | null;
  failedChecks: string[];
};

export type SocialCreativeUsage = {
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
};

export type SocialCreativeGenerationRequest = {
  userId: string;
  businessId: string;
  topic: string;
  kind: SocialPackKind;
  source: SocialCreativeSource;
  sourceBlogId?: string | null;
  sourcePlanId?: string | null;
  socialTopicPlanId?: string | null;
  platforms?: SocialPlatform[];
  idempotencyKey?: string;
};
