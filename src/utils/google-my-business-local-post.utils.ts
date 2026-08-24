export const INTERNAL_GMB_POST_TYPES = [
  "UPDATE",
  "EVENT",
  "OFFER",
  "PRODUCT",
] as const;

export type InternalGMBPostType = (typeof INTERNAL_GMB_POST_TYPES)[number];

export type EffectiveGMBPostType = "UPDATE" | "PRODUCT";

export type GoogleLocalPostTopicType = "STANDARD" | "EVENT" | "OFFER" | "ALERT";

export type GoogleLocalPostActionType =
  | "BOOK"
  | "ORDER"
  | "SHOP"
  | "LEARN_MORE"
  | "SIGN_UP"
  | "CALL";

export type GoogleLocalPostCreatePayload = {
  languageCode: string;
  summary: string;
  topicType: GoogleLocalPostTopicType;
  callToAction?: {
    actionType: GoogleLocalPostActionType;
    url?: string;
  };
  media?: Array<{
    mediaFormat: "PHOTO";
    sourceUrl: string;
  }>;
};

type BuildGoogleLocalPostPayloadInput = {
  postType: InternalGMBPostType;
  summary: string;
  callToAction?: string | null;
  mediaUrls?: string[] | null;
  businessWebsiteUrl?: string | null;
  defaultLocale?: string | null;
};

export type BuildGoogleLocalPostPayloadResult = {
  payload: GoogleLocalPostCreatePayload;
  requestedPostType: InternalGMBPostType;
  effectivePostType: EffectiveGMBPostType;
  warnings: string[];
  destinationUrl: string | null;
};

function normalizeAbsoluteHttpUrl(value?: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const normalized = new URL(value.trim());
    if (!/^https?:$/i.test(normalized.protocol)) {
      return null;
    }
    return normalized.toString();
  } catch {
    return null;
  }
}

function normalizeDestinationUrl(
  callToAction: string | null | undefined,
  businessWebsiteUrl: string | null | undefined,
  warnings: string[],
): string | null {
  const directUrl = normalizeAbsoluteHttpUrl(callToAction);
  if (directUrl) {
    return directUrl;
  }

  const websiteUrl = normalizeAbsoluteHttpUrl(businessWebsiteUrl);
  if (!callToAction?.trim()) {
    return websiteUrl;
  }

  if (callToAction.trim().startsWith("/") && websiteUrl) {
    try {
      return new URL(callToAction.trim(), websiteUrl).toString();
    } catch {
      // Fall through to the website fallback below.
    }
  }

  if (websiteUrl) {
    warnings.push(
      "Destination URL was not a valid absolute URL, so the business website URL was used instead.",
    );
    return websiteUrl;
  }

  warnings.push(
    "Destination URL was omitted because no valid post URL or business website URL was available.",
  );
  return null;
}

function normalizeMediaUrls(
  mediaUrls: string[] | null | undefined,
  warnings: string[],
): Array<{ mediaFormat: "PHOTO"; sourceUrl: string }> | undefined {
  if (!mediaUrls?.length) {
    return undefined;
  }

  const valid = Array.from(
    new Set(
      mediaUrls
        .map((url) => normalizeAbsoluteHttpUrl(url))
        .filter((url): url is string => Boolean(url)),
    ),
  );

  if (valid.length !== mediaUrls.length) {
    warnings.push("One or more invalid media URLs were dropped before publishing.");
  }

  if (valid.length === 0) {
    return undefined;
  }

  return valid.map((sourceUrl) => ({
    mediaFormat: "PHOTO" as const,
    sourceUrl,
  }));
}

function normalizeLanguageCode(defaultLocale?: string | null): string {
  const raw = defaultLocale?.trim().replace(/_/g, "-");
  if (!raw) {
    return "en-US";
  }

  const match = raw.match(/^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2}))?$/);
  if (!match) {
    return "en-US";
  }

  const languagePart = match[1];
  if (!languagePart) {
    return "en-US";
  }

  const language = languagePart.toLowerCase();
  const region = match[2]?.toUpperCase();

  return region ? `${language}-${region}` : language;
}

export function normalizeGmbPostTypeForPublishing(
  requestedPostType: InternalGMBPostType,
): { effectivePostType: EffectiveGMBPostType; topicType: "STANDARD"; warnings: string[] } {
  if (requestedPostType === "PRODUCT") {
    return {
      effectivePostType: "PRODUCT",
      topicType: "STANDARD",
      warnings: [],
    };
  }

  if (requestedPostType === "EVENT" || requestedPostType === "OFFER") {
    return {
      effectivePostType: "UPDATE",
      topicType: "STANDARD",
      warnings: [
        `${requestedPostType} posts were downgraded to STANDARD because the current product flow does not collect Google's required ${requestedPostType.toLowerCase()} fields yet.`,
      ],
    };
  }

  return {
    effectivePostType: "UPDATE",
    topicType: "STANDARD",
    warnings: [],
  };
}

export function buildGoogleLocalPostPayload(
  input: BuildGoogleLocalPostPayloadInput,
): BuildGoogleLocalPostPayloadResult {
  const typeResolution = normalizeGmbPostTypeForPublishing(input.postType);
  const warnings = [...typeResolution.warnings];
  const destinationUrl = normalizeDestinationUrl(
    input.callToAction,
    input.businessWebsiteUrl,
    warnings,
  );
  const media = normalizeMediaUrls(input.mediaUrls, warnings);

  const callToAction =
    destinationUrl == null
      ? undefined
      : {
          actionType:
            (typeResolution.effectivePostType === "PRODUCT" ? "SHOP" : "LEARN_MORE") as GoogleLocalPostActionType,
          url: destinationUrl,
        };

  return {
    requestedPostType: input.postType,
    effectivePostType: typeResolution.effectivePostType,
    destinationUrl,
    warnings,
    payload: {
      languageCode: normalizeLanguageCode(input.defaultLocale),
      summary: input.summary.trim(),
      topicType: typeResolution.topicType,
      ...(callToAction ? { callToAction } : {}),
      ...(media ? { media } : {}),
    },
  };
}
