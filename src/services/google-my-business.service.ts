import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { decrypt, encrypt, isEncrypted } from "../utils/encryption";
import {
  buildGoogleLocalPostPayload,
  type InternalGMBPostType,
} from "../utils/google-my-business-local-post.utils";
import {
  filterGoogleReviewsToWindow,
  getGmbReviewWindowStart,
  shouldStopGoogleReviewPagination,
} from "../utils/gmb-review-window.utils";
import {
  assessGmbConnectionHealth,
  getPublicGmbConnectionIssue,
  type GMBConnectionHealth,
} from "../utils/gmb-connection-health";
import {
  gmbDemoDataService,
  isDemoGmbConnection,
  isGmbDemoModeEnabled,
} from "./gmb-demo-data.service";

export const GMB_TOKEN_ENCRYPTION_CONTEXT = "gmb-tokens";
export const GMB_RECONNECT_REQUIRED_MESSAGE =
  "Reconnect required to select business location";

export interface GMBPostData {
  postType: InternalGMBPostType;
  summary: string;
  callToAction?: string;
  mediaUrls?: string[];
  title?: string;
}

export interface GMBLocationCandidate {
  accountId: string;
  accountName: string;
  locationId: string;
  locationName: string;
  address?: string | null;
}

export type GMBReviewReplyStatus =
  | "posted"
  | "already_responded_local"
  | "already_exists_remote"
  | "not_found_remote";

export interface GMBReviewReplyResult {
  status: GMBReviewReplyStatus;
  reviewId: string;
  response?: string | null;
  responseDate?: string | null;
}

export interface GMBAutomationSettings {
  autoPostToGmbEnabled: boolean;
  autoReviewReplyEnabled: boolean;
  postAutomationMode: "approval_required" | "auto_publish" | "disabled";
  reviewReplyMode: "approval_required" | "auto_publish" | "disabled";
  profileEditMode: "approval_required" | "disabled";
  mediaPublishingMode: "approval_required" | "auto_publish" | "disabled";
  rankScanCadence: "manual" | "weekly" | "monthly";
  notificationPreferences?: Record<string, unknown> | null;
}

export type GMBConnectionStatus =
  | { state: "disconnected"; health?: GMBConnectionHealth }
  | {
      state: "pending_location_selection";
      businessId: string;
      candidates: GMBLocationCandidate[];
      lastSyncError?: string | null;
      health?: GMBConnectionHealth;
    }
  | {
      state: "reconnect_required";
      businessId: string;
      lastSyncAt?: string | null;
      lastSyncError?: string | null;
      health?: GMBConnectionHealth;
    }
  | {
      state: "connected";
      businessId: string;
      accountId: string;
      accountName?: string | null;
      locationId: string;
      locationName?: string | null;
      businessName?: string | null;
      businessAddress?: string | null;
      businessPhone?: string | null;
      businessWebsite?: string | null;
      lastSyncAt?: string | null;
      lastSyncError?: string | null;
      health?: GMBConnectionHealth;
      isDemo: boolean;
      settings: GMBAutomationSettings;
    };

export interface GMBDashboardData {
  profile: {
    businessName?: string | null;
    businessAddress?: string | null;
    businessPhone?: string | null;
    businessWebsite?: string | null;
    verified?: boolean | null;
    rating?: number | null;
    totalReviews?: number | null;
    totalPosts?: number | null;
    categories: string[];
  };
  posts: Array<{
    id: string;
    postId?: string | null;
    postType: "UPDATE" | "EVENT" | "OFFER" | "PRODUCT";
    title?: string | null;
    summary?: string | null;
    callToAction?: string | null;
    mediaUrls: string[];
    status: "DRAFT" | "PUBLISHED" | "FAILED";
    publishedAt?: string | null;
  }>;
  reviews: Array<{
    id: string;
    reviewId: string;
    reviewerName: string;
    reviewerPhoto?: string | null;
    rating: number;
    comment?: string | null;
    reviewDate: string;
    response?: string | null;
    responseDate?: string | null;
    isResponded: boolean;
  }>;
  settings: GMBAutomationSettings;
  insights: {
    views: number;
    clicks: number;
    calls: number;
    directionRequests: number;
  };
  syncedAt: string;
  source: "live" | "cache" | "error";
}

type GoogleAccount = {
  name?: string;
  accountName?: string;
};

export type GoogleLocation = {
  name?: string;
  title?: string;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    regionCode?: string;
  };
  phoneNumbers?: {
    primaryPhone?: string;
  };
  websiteUri?: string;
  categories?: {
    primaryCategory?: { displayName?: string; name?: string };
    additionalCategories?: Array<{ displayName?: string; name?: string }>;
  };
  regularHours?: unknown;
  specialHours?: unknown;
  moreHours?: unknown;
  serviceArea?: unknown;
  serviceItems?: unknown;
  profile?: {
    description?: string;
  };
  metadata?: {
    placeId?: string;
    mapsUri?: string;
    newReviewUri?: string;
    hasPendingEdits?: boolean;
    hasGoogleUpdated?: boolean;
    canDelete?: boolean;
    canHaveFoodMenus?: boolean;
    canOperateHealthData?: boolean;
    canOperateLodgingData?: boolean;
    canModifyServiceList?: boolean;
    canHaveBusinessCalls?: boolean;
    canOperateLocalPost?: boolean;
    placeUri?: string;
    duplicateLocation?: string;
  };
  openInfo?: {
    status?: string; // "OPEN" | "CLOSED_PERMANENTLY" | "CLOSED_TEMPORARILY"
    canReopen?: boolean;
  };
  attributes?: unknown;
};

type GoogleLocalPost = {
  name?: string;
  summary?: string;
  topicType?: string;
  createTime?: string;
  callToAction?: {
    actionType?: string;
    url?: string;
  };
  media?: Array<{
    sourceUrl?: string;
    googleUrl?: string;
  }>;
};

type GoogleReview = {
  name?: string;
  reviewer?: {
    displayName?: string;
    profilePhotoUrl?: string;
  };
  starRating?: number | string;
  comment?: string;
  createTime?: string;
  reviewReply?: {
    comment?: string;
    updateTime?: string;
  };
};

type DatedValue = {
  date?: { year?: number; month?: number; day?: number };
  value?:
    | string
    | number
    | {
        int64Value?: string;
        doubleValue?: number;
        floatValue?: number;
        value?: string | number;
      };
};

type DailyMetricEntry = {
  dailyMetric?: string;
  timeSeries?: {
    datedValues?: DatedValue[];
  };
};

type GooglePerformanceResponse = {
  multiDailyMetricTimeSeries?: Array<{
    dailyMetricTimeSeries?: DailyMetricEntry[];
  }>;
};

export type GMBPerformanceDailyMetric = {
  date: string;
  impressionsSearch: number;
  impressionsMaps: number;
  websiteClicks: number;
  callClicks: number;
  directionRequests: number;
  bookings: number;
  menuClicks: number;
  foodOrders: number;
  raw: Record<string, number>;
};

export type GMBDiscoveryKeywordMetric = {
  keyword: string;
  month: string;
  impressions: number;
  raw?: unknown;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type GoogleOAuthErrorResponse = {
  error?: string;
  error_description?: string;
};

type GoogleConnectionRecord = Awaited<
  ReturnType<GoogleMyBusinessService["getConnectionRecord"]>
>;

type CachedGMBPost = Awaited<ReturnType<typeof prisma.gMBPost.findFirst>>;

type GMBApiError = Error & {
  status?: number;
  endpoint?: string;
  body?: string;
};

const PROFILE_READ_MASK = [
  "name",
  "title",
  "storefrontAddress",
  "phoneNumbers",
  "websiteUri",
  "categories",
  "regularHours",
  "specialHours",
  "moreHours",
  "serviceArea",
  "serviceItems",
  "profile",
  "metadata",
  "openInfo",
].join(",");

const PERFORMANCE_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "WEBSITE_CLICKS",
  "CALL_CLICKS",
  "BUSINESS_DIRECTION_REQUESTS",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGMBAlreadyExistsError(error: unknown): boolean {
  const gmbError = error as GMBApiError | undefined;
  const message =
    typeof gmbError?.message === "string" ? gmbError.message : "";
  const body = typeof gmbError?.body === "string" ? gmbError.body : "";
  const normalized = `${message}\n${body}`.toLowerCase();

  return (
    gmbError?.status === 409 ||
    normalized.includes("already_exists") ||
    normalized.includes("requested entity already exists")
  );
}

function isGMBNotFoundError(error: unknown): boolean {
  const gmbError = error as GMBApiError | undefined;
  const message =
    typeof gmbError?.message === "string" ? gmbError.message : "";
  const body = typeof gmbError?.body === "string" ? gmbError.body : "";
  const normalized = `${message}\n${body}`.toLowerCase();

  return (
    gmbError?.status === 404 ||
    normalized.includes("not_found") ||
    normalized.includes("requested entity was not found")
  );
}

function parseGoogleOAuthError(errorText: string): GoogleOAuthErrorResponse {
  if (!errorText) {
    return {};
  }

  try {
    const parsed = JSON.parse(errorText) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      error_description:
        typeof parsed.error_description === "string"
          ? parsed.error_description
          : undefined,
    };
  } catch {
    return { error_description: errorText.slice(0, 240) };
  }
}

export class GoogleMyBusinessService {
  private rateLimiter = {
    read: { count: 0, resetTime: Date.now() + 60_000 },
    write: { count: 0, resetTime: Date.now() + 60_000 },
    review: { count: 0, resetTime: Date.now() + 60_000 },
  };

  private async checkRateLimit(type: "read" | "write" | "review") {
    const now = Date.now();
    if (now > this.rateLimiter[type].resetTime) {
      this.rateLimiter[type] = { count: 0, resetTime: now + 60_000 };
    }

    const limits = { read: 100, write: 10, review: 50 };
    if (this.rateLimiter[type].count >= limits[type]) {
      throw new Error(`Rate limit exceeded for ${type} operations`);
    }

    this.rateLimiter[type].count++;
  }

  private normalizeAccountId(accountName?: string | null) {
    if (!accountName) {
      return "";
    }

    const parts = accountName.split("/");
    return parts[parts.length - 1] || accountName;
  }

  private normalizeLocationId(locationName?: string | null) {
    if (!locationName) {
      return "";
    }

    const parts = locationName.split("/");
    return parts[parts.length - 1] || locationName;
  }

  private formatAddress(address?: GoogleLocation["storefrontAddress"]) {
    if (!address) {
      return null;
    }

    const parts = [
      ...(address.addressLines ?? []),
      address.locality,
      address.administrativeArea,
      address.postalCode,
      address.regionCode,
    ].filter(Boolean);

    return parts.length > 0 ? parts.join(", ") : null;
  }

  private extractCategories(location?: GoogleLocation | null) {
    if (!location?.categories) {
      return [];
    }

    const categories = [
      location.categories.primaryCategory?.displayName,
      ...(location.categories.additionalCategories?.map(
        (category) => category.displayName,
      ) ?? []),
    ].filter((value): value is string => Boolean(value));

    return Array.from(new Set(categories));
  }

  private normalizePostType(topicType?: string) {
    switch (topicType) {
      case "EVENT":
      case "OFFER":
        return topicType;
      default:
        return "UPDATE";
    }
  }

  private normalizeRating(starRating?: number | string) {
    if (typeof starRating === "number") {
      return Math.max(1, Math.min(5, starRating));
    }

    switch (starRating) {
      case "ONE":
      case "ONE_STAR":
        return 1;
      case "TWO":
      case "TWO_STARS":
        return 2;
      case "THREE":
      case "THREE_STARS":
        return 3;
      case "FOUR":
      case "FOUR_STARS":
        return 4;
      case "FIVE":
      case "FIVE_STARS":
        return 5;
      default:
        return 5;
    }
  }

  private addGmbUtmParams(url?: string | null, content = "post_cta") {
    if (!url) {
      return url ?? undefined;
    }

    try {
      const tagged = new URL(url);
      tagged.searchParams.set("utm_source", "google");
      tagged.searchParams.set("utm_medium", "organic");
      tagged.searchParams.set("utm_campaign", "gbp");
      tagged.searchParams.set("utm_content", content);
      return tagged.toString();
    } catch {
      return url;
    }
  }

  private extractMetricValue(metric: unknown): number {
    if (typeof metric === "number") {
      return metric;
    }

    if (typeof metric === "string") {
      const parsed = Number(metric);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    if (typeof metric === "object" && metric !== null) {
      if (
        "int64Value" in metric &&
        typeof (metric as { int64Value?: unknown }).int64Value === "string"
      ) {
        return Number((metric as { int64Value: string }).int64Value);
      }

      if (
        "doubleValue" in metric &&
        typeof (metric as { doubleValue?: unknown }).doubleValue === "number"
      ) {
        return (metric as { doubleValue: number }).doubleValue;
      }

      if (
        "floatValue" in metric &&
        typeof (metric as { floatValue?: unknown }).floatValue === "number"
      ) {
        return (metric as { floatValue: number }).floatValue;
      }

      if ("value" in metric) {
        return this.extractMetricValue((metric as { value?: unknown }).value);
      }
    }

    return 0;
  }

  private sumMetricSeries(response: GooglePerformanceResponse, metric: string) {
    const topLevel = response.multiDailyMetricTimeSeries;

    if (!topLevel || topLevel.length === 0) {
      return 0;
    }

    const allMetricEntries: DailyMetricEntry[] = [];
    for (const wrapper of topLevel) {
      if (wrapper.dailyMetricTimeSeries) {
        allMetricEntries.push(...wrapper.dailyMetricTimeSeries);
      }
    }

    const foundEntry = allMetricEntries.find(
      (entry) => entry.dailyMetric === metric,
    );

    if (!foundEntry) {
      return 0;
    }

    const datedValues = foundEntry.timeSeries?.datedValues ?? [];

    return datedValues.reduce(
      (sum, entry) => sum + this.extractMetricValue(entry.value),
      0,
    );
  }

  private googleDateToIso(date?: {
    year?: number;
    month?: number;
    day?: number;
  }): string | null {
    if (!date?.year || !date?.month || !date?.day) {
      return null;
    }

    return [
      String(date.year).padStart(4, "0"),
      String(date.month).padStart(2, "0"),
      String(date.day).padStart(2, "0"),
    ].join("-");
  }

  private googleMonthToIso(date?: { year?: number; month?: number }): string | null {
    if (!date?.year || !date?.month) {
      return null;
    }

    return `${String(date.year).padStart(4, "0")}-${String(
      date.month,
    ).padStart(2, "0")}-01`;
  }

  private getPerformanceDateRange(days: number) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(1, Math.min(days, 180)));

    const params = new URLSearchParams();
    for (const metric of PERFORMANCE_METRICS) {
      params.append("dailyMetrics", metric);
    }
    params.set("dailyRange.start_date.year", String(start.getUTCFullYear()));
    params.set("dailyRange.start_date.month", String(start.getUTCMonth() + 1));
    params.set("dailyRange.start_date.day", String(start.getUTCDate()));
    params.set("dailyRange.end_date.year", String(end.getUTCFullYear()));
    params.set("dailyRange.end_date.month", String(end.getUTCMonth() + 1));
    params.set("dailyRange.end_date.day", String(end.getUTCDate()));

    return params;
  }

  private mapPerformanceResponseToDailyMetrics(
    response: GooglePerformanceResponse,
  ): GMBPerformanceDailyMetric[] {
    const daily = new Map<string, GMBPerformanceDailyMetric>();
    const wrappers = response.multiDailyMetricTimeSeries ?? [];

    for (const wrapper of wrappers) {
      const entries = wrapper.dailyMetricTimeSeries ?? [];
      for (const entry of entries) {
        const metricName = entry.dailyMetric;
        if (!metricName) {
          continue;
        }

        for (const datedValue of entry.timeSeries?.datedValues ?? []) {
          const date = this.googleDateToIso(datedValue.date);
          if (!date) {
            continue;
          }

          const value = this.extractMetricValue(datedValue.value);
          const existing =
            daily.get(date) ??
            {
              date,
              impressionsSearch: 0,
              impressionsMaps: 0,
              websiteClicks: 0,
              callClicks: 0,
              directionRequests: 0,
              bookings: 0,
              menuClicks: 0,
              foodOrders: 0,
              raw: {},
            };

          existing.raw[metricName] = (existing.raw[metricName] ?? 0) + value;

          if (metricName.includes("_SEARCH")) {
            existing.impressionsSearch += value;
          } else if (metricName.includes("_MAPS")) {
            existing.impressionsMaps += value;
          } else if (metricName === "WEBSITE_CLICKS") {
            existing.websiteClicks += value;
          } else if (metricName === "CALL_CLICKS") {
            existing.callClicks += value;
          } else if (metricName === "BUSINESS_DIRECTION_REQUESTS") {
            existing.directionRequests += value;
          } else if (metricName.includes("BOOKING")) {
            existing.bookings += value;
          } else if (metricName.includes("MENU")) {
            existing.menuClicks += value;
          } else if (metricName.includes("FOOD")) {
            existing.foodOrders += value;
          }

          daily.set(date, existing);
        }
      }
    }

    return Array.from(daily.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  private encryptToken(token: string) {
    if (!token) {
      return token;
    }

    if (!process.env.ENCRYPTION_KEY) {
      return token;
    }

    return isEncrypted(token)
      ? token
      : encrypt(token, GMB_TOKEN_ENCRYPTION_CONTEXT);
  }

  private decryptToken(token: string) {
    if (!token) {
      return token;
    }

    return isEncrypted(token)
      ? decrypt(token, GMB_TOKEN_ENCRYPTION_CONTEXT)
      : token;
  }

  private normalizePublishingMode(
    mode?: string | null,
  ): "approval_required" | "auto_publish" | "disabled" {
    return mode === "auto_publish" || mode === "disabled"
      ? mode
      : "approval_required";
  }

  private normalizePostAutomationMode(
    mode?: string | null,
  ): "approval_required" | "auto_publish" | "disabled" {
    return this.normalizePublishingMode(mode);
  }

  private normalizeEditMode(
    mode?: string | null,
  ): "approval_required" | "disabled" {
    return mode === "disabled" ? "disabled" : "approval_required";
  }

  private normalizeRankScanCadence(
    cadence?: string | null,
  ): "manual" | "weekly" | "monthly" {
    if (cadence === "manual" || cadence === "monthly") {
      return cadence;
    }

    return "weekly";
  }

  private normalizeNotificationPreferences(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private buildConnectedStatus(record: {
    businessId: string;
    accountId: string | null;
    accountName: string | null;
    locationId: string | null;
    locationName: string | null;
    businessName: string | null;
    businessAddress: string | null;
    businessPhone: string | null;
    businessWebsite: string | null;
    lastSyncAt: Date | null;
    lastSyncError: string | null;
    isDemo?: boolean;
    autoPostToGmbEnabled: boolean;
    autoReviewReplyEnabled: boolean;
    postAutomationMode: string;
    reviewReplyMode: string;
    profileEditMode: string;
    mediaPublishingMode: string;
    rankScanCadence: string;
    notificationPreferences: Prisma.JsonValue | null;
  }): GMBConnectionStatus {
    if (!record.accountId || !record.locationId) {
      return { state: "disconnected" };
    }

    const health = assessGmbConnectionHealth({
      accessTokenPresent: true,
      isActive: true,
      accountId: record.accountId,
      locationId: record.locationId,
      lastSyncAt: record.lastSyncAt,
      lastSyncError: record.lastSyncError,
    });

    return {
      state: "connected",
      businessId: record.businessId,
      accountId: record.accountId,
      accountName: record.accountName,
      locationId: record.locationId,
      locationName: record.locationName,
      businessName: record.businessName,
      businessAddress: record.businessAddress,
      businessPhone: record.businessPhone,
      businessWebsite: record.businessWebsite,
      lastSyncAt: record.lastSyncAt?.toISOString() ?? null,
      lastSyncError: getPublicGmbConnectionIssue(health.state),
      health,
      isDemo: record.isDemo ?? false,
      settings: {
        autoPostToGmbEnabled: record.autoPostToGmbEnabled,
        autoReviewReplyEnabled: record.autoReviewReplyEnabled,
        postAutomationMode: this.normalizePostAutomationMode(
          record.postAutomationMode,
        ),
        reviewReplyMode: this.normalizePublishingMode(record.reviewReplyMode),
        profileEditMode: this.normalizeEditMode(record.profileEditMode),
        mediaPublishingMode: this.normalizePublishingMode(
          record.mediaPublishingMode,
        ),
        rankScanCadence: this.normalizeRankScanCadence(record.rankScanCadence),
        notificationPreferences:
          this.normalizeNotificationPreferences(record.notificationPreferences),
      },
    };
  }

  private async getConnectionRecord(
    businessId: string,
    options?: { requireActive?: boolean },
  ) {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
    });

    if (!gmb) {
      throw new Error("Google My Business not connected");
    }

    if (gmb.isDemo && !isGmbDemoModeEnabled()) {
      throw new Error("Google My Business not connected");
    }

    if (options?.requireActive !== false && !gmb.isActive) {
      throw new Error("Google My Business connection is inactive");
    }

    return gmb;
  }

  private async updateSyncStatus(
    businessId: string,
    data: Prisma.GoogleMyBusinessUpdateInput,
  ) {
    await prisma.googleMyBusiness.update({
      where: { businessId },
      data,
    });
  }

  async getAutomationSettings(businessId: string): Promise<GMBAutomationSettings> {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: {
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: true,
        reviewReplyMode: true,
        profileEditMode: true,
        mediaPublishingMode: true,
        rankScanCadence: true,
        notificationPreferences: true,
      },
    });

    if (!gmb) {
      throw new Error("Google My Business not connected");
    }

    return {
      autoPostToGmbEnabled: gmb.autoPostToGmbEnabled,
      autoReviewReplyEnabled: gmb.autoReviewReplyEnabled,
      postAutomationMode: this.normalizePostAutomationMode(
        gmb.postAutomationMode,
      ),
      reviewReplyMode: this.normalizePublishingMode(gmb.reviewReplyMode),
      profileEditMode: this.normalizeEditMode(gmb.profileEditMode),
      mediaPublishingMode: this.normalizePublishingMode(
        gmb.mediaPublishingMode,
      ),
      rankScanCadence: this.normalizeRankScanCadence(gmb.rankScanCadence),
      notificationPreferences:
        this.normalizeNotificationPreferences(gmb.notificationPreferences),
    };
  }

  async updateAutomationSettings(
    businessId: string,
    settings: Partial<GMBAutomationSettings>,
  ): Promise<GMBAutomationSettings> {
    const data: Prisma.GoogleMyBusinessUpdateInput = {};

    if (typeof settings.autoPostToGmbEnabled === "boolean") {
      data.autoPostToGmbEnabled = settings.autoPostToGmbEnabled;
    }
    if (typeof settings.autoReviewReplyEnabled === "boolean") {
      data.autoReviewReplyEnabled = settings.autoReviewReplyEnabled;
    }
    if (settings.postAutomationMode) {
      data.postAutomationMode = settings.postAutomationMode;
      data.autoPostToGmbEnabled = settings.postAutomationMode !== "disabled";
    }
    if (settings.reviewReplyMode) {
      data.reviewReplyMode = settings.reviewReplyMode;
      data.autoReviewReplyEnabled = settings.reviewReplyMode !== "disabled";
    }
    if (settings.profileEditMode) {
      data.profileEditMode = settings.profileEditMode;
    }
    if (settings.mediaPublishingMode) {
      data.mediaPublishingMode = settings.mediaPublishingMode;
    }
    if (settings.rankScanCadence) {
      data.rankScanCadence = settings.rankScanCadence;
    }
    if (settings.notificationPreferences !== undefined) {
      data.notificationPreferences =
        settings.notificationPreferences as Prisma.InputJsonValue;
    }

    if (Object.keys(data).length === 0) {
      return this.getAutomationSettings(businessId);
    }

    return prisma.googleMyBusiness.update({
      where: { businessId },
      data,
      select: {
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: true,
        reviewReplyMode: true,
        profileEditMode: true,
        mediaPublishingMode: true,
        rankScanCadence: true,
        notificationPreferences: true,
      },
    }).then((settings) => ({
      autoPostToGmbEnabled: settings.autoPostToGmbEnabled,
      autoReviewReplyEnabled: settings.autoReviewReplyEnabled,
      postAutomationMode: this.normalizePostAutomationMode(
        settings.postAutomationMode,
      ),
      reviewReplyMode: this.normalizePublishingMode(settings.reviewReplyMode),
      profileEditMode: this.normalizeEditMode(settings.profileEditMode),
      mediaPublishingMode: this.normalizePublishingMode(
        settings.mediaPublishingMode,
      ),
      rankScanCadence: this.normalizeRankScanCadence(settings.rankScanCadence),
      notificationPreferences:
        this.normalizeNotificationPreferences(settings.notificationPreferences),
    }));
  }

  async isAutoPostToGmbEnabled(businessId: string): Promise<boolean> {
    const settings = await this.getAutomationSettings(businessId);
    return (
      settings.autoPostToGmbEnabled &&
      settings.postAutomationMode === "auto_publish"
    );
  }

  async isAutoReviewReplyEnabled(businessId: string): Promise<boolean> {
    const settings = await this.getAutomationSettings(businessId);
    return (
      settings.autoReviewReplyEnabled &&
      settings.reviewReplyMode === "auto_publish"
    );
  }

  private async getValidToken(
    businessId: string,
    options?: { requireActive?: boolean },
  ): Promise<string> {
    const gmb = await this.getConnectionRecord(businessId, options);

    if (isDemoGmbConnection(gmb)) {
      return "demo-token";
    }

    if (!gmb.accessToken) {
      throw new Error("Google My Business not connected");
    }

    if (new Date() > gmb.tokenExpiry) {
      return this.refreshToken(businessId, gmb.refreshToken);
    }

    return this.decryptToken(gmb.accessToken);
  }

  private async refreshToken(
    businessId: string,
    storedRefreshToken: string,
  ): Promise<string> {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error("Google OAuth client credentials are not configured");
      }

      const refreshToken = this.decryptToken(storedRefreshToken);
      if (!refreshToken) {
        throw new Error("Refresh token is not available");
      }

      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const oauthError = parseGoogleOAuthError(errorText);
        console.error("[GMB OAuth] Token refresh failed:", {
          businessId,
          status: response.status,
          error: oauthError.error,
          errorDescription: oauthError.error_description,
        });

        if (oauthError.error === "invalid_grant") {
          await prisma.googleMyBusiness.update({
            where: { businessId },
            data: {
              isActive: false,
              lastSyncError:
                "Google Business Profile reconnect required: refresh token is invalid or revoked",
            },
          });

          throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
        }

        throw new Error(
          `Failed to refresh token: ${oauthError.error ?? response.status}`,
        );
      }

      const tokens = (await response.json()) as GoogleTokenResponse;
      if (!tokens.access_token || !tokens.expires_in) {
        throw new Error("Failed to refresh access token");
      }

      await prisma.googleMyBusiness.update({
        where: { businessId },
        data: {
          accessToken: this.encryptToken(tokens.access_token),
          refreshToken: tokens.refresh_token
            ? this.encryptToken(tokens.refresh_token)
            : storedRefreshToken,
          tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        },
      });

      return tokens.access_token;
    } catch (error) {
      console.error("Token refresh error:", error);
      throw new Error("Failed to refresh Google My Business token");
    }
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit,
    rateLimitType: "read" | "write" | "review" = "read",
  ): Promise<T> {
    await this.checkRateLimit(rateLimitType);

    const response = await fetch(endpoint, {
      ...options,
      headers: {
        ...options.headers,
        "User-Agent": "SEO-Tool/1.0",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[GMB] API Error:", response.status, endpoint, errorText);
      const error = new Error(
        `GMB API Error: ${response.status} - ${errorText || response.statusText}`,
      ) as GMBApiError;
      error.status = response.status;
      error.endpoint = endpoint;
      error.body = errorText;
      throw error;
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async listAccountsWithToken(token: string): Promise<GoogleAccount[]> {
    console.log("[GMB] Fetching accounts from Google Business Profile API...");
    const response = await this.makeRequest<{ accounts?: GoogleAccount[] }>(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      "read",
    );

    console.log("[GMB] Found", response.accounts?.length ?? 0, "account(s)");

    return response.accounts ?? [];
  }

  private async listLocationsForAccount(
    token: string,
    accountId: string,
  ): Promise<GoogleLocation[]> {
    const normalizedAccountId = this.normalizeAccountId(accountId);
    console.log("[GMB] Fetching locations for account:", normalizedAccountId);

    const response = await this.makeRequest<{ locations?: GoogleLocation[] }>(
      `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${normalizedAccountId}/locations?readMask=${PROFILE_READ_MASK}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      "read",
    );

    console.log(
      "[GMB] Found",
      response.locations?.length ?? 0,
      "location(s) for account",
      normalizedAccountId,
    );

    return response.locations ?? [];
  }

  private async getLocationDetailsWithToken(token: string, locationId: string) {
    const normalizedLocationId = this.normalizeLocationId(locationId);

    return this.makeRequest<GoogleLocation>(
      `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${normalizedLocationId}?readMask=${PROFILE_READ_MASK}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      "read",
    );
  }

  private async buildLocationCandidatesFromToken(token: string) {
    console.log("[GMB] Building location candidates from token...");
    const accounts = await this.listAccountsWithToken(token);
    const candidates: GMBLocationCandidate[] = [];

    if (accounts.length === 0) {
      console.log(
        "[GMB] No accounts found. This could mean:",
        "\n  1. The Google account has no Business Profile",
        "\n  2. The APIs are not enabled in Google Cloud Console",
        "\n  3. The user doesn't have owner/manager permissions",
      );
    }

    for (const account of accounts) {
      const normalizedAccountId = this.normalizeAccountId(account.name);
      if (!normalizedAccountId) {
        continue;
      }

      const locations = await this.listLocationsForAccount(
        token,
        normalizedAccountId,
      );

      for (const location of locations) {
        const normalizedLocationId = this.normalizeLocationId(location.name);
        if (!normalizedLocationId) {
          console.log(
            "[GMB] Skipping location - missing name field:",
            location.title,
          );
          continue;
        }

        candidates.push({
          accountId: normalizedAccountId,
          accountName:
            account.accountName || account.name || normalizedAccountId,
          locationId: normalizedLocationId,
          locationName: location.title || location.name || "Business location",
          address: this.formatAddress(location.storefrontAddress),
        });
      }
    }

    console.log(
      "[GMB] Total location candidates found:",
      candidates.length,
      candidates.length > 0
        ? candidates.map((c) => `${c.locationName} (${c.locationId})`)
        : "(none)",
    );

    return candidates;
  }

  private async persistLocationSelection(
    businessId: string,
    tokenData: {
      accessToken: string;
      refreshToken?: string | null;
      tokenExpiry: Date;
    },
    candidate: GMBLocationCandidate,
  ): Promise<GMBConnectionStatus> {
    const locationDetails = await this.getLocationDetailsWithToken(
      tokenData.accessToken,
      candidate.locationId,
    );

    const record = await prisma.googleMyBusiness.upsert({
      where: { businessId },
      update: {
        accessToken: this.encryptToken(tokenData.accessToken),
        refreshToken: tokenData.refreshToken
          ? this.encryptToken(tokenData.refreshToken)
          : undefined,
        tokenExpiry: tokenData.tokenExpiry,
        accountId: candidate.accountId,
        accountName: candidate.accountName,
        locationId: candidate.locationId,
        locationName: locationDetails.title ?? candidate.locationName,
        businessName: locationDetails.title ?? candidate.locationName,
        businessAddress:
          this.formatAddress(locationDetails.storefrontAddress) ??
          candidate.address ??
          null,
        businessPhone: locationDetails.phoneNumbers?.primaryPhone ?? null,
        businessWebsite: locationDetails.websiteUri ?? null,
        isActive: true,
        isDemo: false,
        lastSyncError: null,
      },
      create: {
        businessId,
        accessToken: this.encryptToken(tokenData.accessToken),
        refreshToken: this.encryptToken(tokenData.refreshToken ?? ""),
        tokenExpiry: tokenData.tokenExpiry,
        accountId: candidate.accountId,
        accountName: candidate.accountName,
        locationId: candidate.locationId,
        locationName: locationDetails.title ?? candidate.locationName,
        businessName: locationDetails.title ?? candidate.locationName,
        businessAddress:
          this.formatAddress(locationDetails.storefrontAddress) ??
          candidate.address ??
          null,
        businessPhone: locationDetails.phoneNumbers?.primaryPhone ?? null,
        businessWebsite: locationDetails.websiteUri ?? null,
        isActive: true,
        isDemo: false,
        lastSyncError: null,
      },
      select: {
        businessId: true,
        accountId: true,
        accountName: true,
        locationId: true,
        locationName: true,
        businessName: true,
        businessAddress: true,
        businessPhone: true,
        businessWebsite: true,
        lastSyncAt: true,
        lastSyncError: true,
        isDemo: true,
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: true,
        reviewReplyMode: true,
        profileEditMode: true,
        mediaPublishingMode: true,
        rankScanCadence: true,
        notificationPreferences: true,
      },
    });

    return this.buildConnectedStatus(record);
  }

  async completeOAuthConnection(
    businessId: string,
    tokens: Required<Pick<GoogleTokenResponse, "access_token" | "expires_in">> &
      Pick<GoogleTokenResponse, "refresh_token">,
  ): Promise<GMBConnectionStatus> {
    const existingConnection = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: {
        refreshToken: true,
      },
    });

    const candidates = await this.buildLocationCandidatesFromToken(
      tokens.access_token,
    );

    const [singleCandidate] = candidates;
    if (singleCandidate && candidates.length === 1) {
      return this.persistLocationSelection(
        businessId,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        },
        singleCandidate,
      );
    }

    await prisma.googleMyBusiness.upsert({
      where: { businessId },
      update: {
        accessToken: this.encryptToken(tokens.access_token),
        refreshToken: tokens.refresh_token
          ? this.encryptToken(tokens.refresh_token)
          : existingConnection?.refreshToken || "",
        tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        accountId: null,
        accountName: null,
        locationId: null,
        locationName: null,
        businessName: null,
        businessAddress: null,
        businessPhone: null,
        businessWebsite: null,
        isActive: false,
        isDemo: false,
        lastSyncError:
          candidates.length === 0
            ? "No accessible Google Business locations found"
            : null,
      },
      create: {
        businessId,
        accessToken: this.encryptToken(tokens.access_token),
        refreshToken: this.encryptToken(tokens.refresh_token ?? ""),
        tokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
        accountId: null,
        accountName: null,
        locationId: null,
        locationName: null,
        businessName: null,
        businessAddress: null,
        businessPhone: null,
        businessWebsite: null,
        isActive: false,
        isDemo: false,
        lastSyncError:
          candidates.length === 0
            ? "No accessible Google Business locations found"
            : null,
      },
    });

    return {
      state: "pending_location_selection",
      businessId,
      candidates,
      lastSyncError:
        candidates.length === 0
          ? "No accessible Google Business locations found"
          : null,
    };
  }

  async selectLocation(
    businessId: string,
    candidate: GMBLocationCandidate,
  ): Promise<GMBConnectionStatus> {
    const record = await this.getConnectionRecord(businessId, {
      requireActive: false,
    });
    const token = await this.getValidToken(businessId, {
      requireActive: false,
    });
    const locationDetails = await this.getLocationDetailsWithToken(
      token,
      candidate.locationId,
    );

    const updated = await prisma.googleMyBusiness.update({
      where: { businessId },
      data: {
        accountId: candidate.accountId,
        accountName: candidate.accountName,
        locationId: candidate.locationId,
        locationName: locationDetails.title ?? candidate.locationName,
        businessName: locationDetails.title ?? candidate.locationName,
        businessAddress:
          this.formatAddress(locationDetails.storefrontAddress) ??
          candidate.address ??
          null,
        businessPhone: locationDetails.phoneNumbers?.primaryPhone ?? null,
        businessWebsite: locationDetails.websiteUri ?? null,
        isActive: true,
        isDemo: false,
        lastSyncError: null,
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        tokenExpiry: record.tokenExpiry,
      },
      select: {
        businessId: true,
        accountId: true,
        accountName: true,
        locationId: true,
        locationName: true,
        businessName: true,
        businessAddress: true,
        businessPhone: true,
        businessWebsite: true,
        lastSyncAt: true,
        lastSyncError: true,
        isDemo: true,
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: true,
        reviewReplyMode: true,
        profileEditMode: true,
        mediaPublishingMode: true,
        rankScanCadence: true,
        notificationPreferences: true,
      },
    });

    return this.buildConnectedStatus(updated);
  }

  async getAccounts(businessId: string) {
    const token = await this.getValidToken(businessId, {
      requireActive: false,
    });
    const accounts = await this.listAccountsWithToken(token);

    return {
      accounts: accounts.map((account) => ({
        id: this.normalizeAccountId(account.name),
        name:
          account.accountName ||
          account.name ||
          this.normalizeAccountId(account.name),
      })),
    };
  }

  async getLocations(businessId: string, accountId: string) {
    const token = await this.getValidToken(businessId, {
      requireActive: false,
    });
    const locations = await this.listLocationsForAccount(token, accountId);

    return {
      locations: locations.map((location) => ({
        id: this.normalizeLocationId(location.name),
        name: location.title || location.name || "Business location",
        address: this.formatAddress(location.storefrontAddress),
      })),
    };
  }

  async createPost(businessId: string, postData: GMBPostData) {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.accountId || !gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      const createdPost = await gmbDemoDataService.createDemoPost(
        businessId,
        postData,
      );
      return this.mapCachedPost(createdPost);
    }

    const token = await this.getValidToken(businessId);

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        businessWebsiteUrl: true,
        defaultLocale: true,
      },
    });

    const localPost = buildGoogleLocalPostPayload({
      postType: postData.postType,
      summary: postData.summary,
      callToAction: this.addGmbUtmParams(postData.callToAction),
      mediaUrls: postData.mediaUrls,
      businessWebsiteUrl: business?.businessWebsiteUrl ?? null,
      defaultLocale: business?.defaultLocale ?? null,
    });

    if (localPost.warnings.length > 0) {
      console.warn("[GMB] LocalPost payload normalization warnings:", {
        businessId,
        requestedPostType: localPost.requestedPostType,
        effectivePostType: localPost.effectivePostType,
        warnings: localPost.warnings,
      });
    }

    const result = await this.makeRequest<GoogleLocalPost>(
      `https://mybusiness.googleapis.com/v4/accounts/${gmb.accountId}/locations/${gmb.locationId}/localPosts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(localPost.payload),
      },
      "write",
    );

    const createdPost = await this.upsertPostRecord(
      gmb.id,
      result,
      postData.title,
    );
    return this.mapCachedPost(createdPost);
  }

  async getPosts(businessId: string, locationId?: string, providedToken?: string) {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.accountId || !gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      const cachedPosts = await this.getCachedPosts(businessId);
      return {
        localPosts: cachedPosts.map((post) => ({
          name: post.postId ?? undefined,
          summary: post.summary ?? undefined,
          topicType: post.postType,
          createTime: post.publishedAt?.toISOString() ?? post.createdAt.toISOString(),
          callToAction: post.callToAction
            ? { actionType: "LEARN_MORE", url: post.callToAction }
            : undefined,
          media: post.mediaUrls.map((url) => ({ sourceUrl: url })),
        })),
      };
    }

    const token = providedToken ?? await this.getValidToken(businessId);

    const targetLocationId = locationId || gmb.locationId;

    return this.makeRequest<{ localPosts?: GoogleLocalPost[] }>(
      `https://mybusiness.googleapis.com/v4/accounts/${gmb.accountId}/locations/${targetLocationId}/localPosts`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      "read",
    );
  }

  async getReviews(businessId: string, locationId?: string, providedToken?: string) {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.accountId || !gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      const reviews = await this.getCachedReviews(businessId);
      return {
        reviews: reviews.map((review) => ({
          name: review.reviewId,
          reviewer: {
            displayName: review.reviewerName,
            profilePhotoUrl: review.reviewerPhoto ?? undefined,
          },
          starRating: review.rating,
          comment: review.comment ?? undefined,
          createTime: review.reviewDate.toISOString(),
          reviewReply: review.response
            ? {
                comment: review.response,
                updateTime: review.responseDate?.toISOString(),
              }
            : undefined,
        })),
        totalReviewCount: reviews.length,
        averageRating:
          reviews.length > 0
            ? reviews.reduce((sum, review) => sum + review.rating, 0) /
              reviews.length
            : undefined,
        newUnrespondedReviews: [],
      };
    }

    const token = providedToken ?? await this.getValidToken(businessId);

    const targetLocationId = locationId || gmb.locationId;
    const baseUrl = `https://mybusiness.googleapis.com/v4/accounts/${gmb.accountId}/locations/${targetLocationId}/reviews`;
    const allReviews: GoogleReview[] = [];
    let pageToken: string | undefined;
    const reviewWindowStart = getGmbReviewWindowStart();

    do {
      const url = new URL(baseUrl);
      url.searchParams.set("pageSize", "50");
      url.searchParams.set("orderBy", "updateTime desc");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      const result = await this.makeRequest<{
        reviews?: GoogleReview[];
        nextPageToken?: string;
        totalReviewCount?: number;
        averageRating?: number;
      }>(
        url.toString(),
        { headers: { Authorization: `Bearer ${token}` } },
        "review",
      );

      const pageReviews = result.reviews ?? [];
      allReviews.push(...filterGoogleReviewsToWindow(pageReviews, reviewWindowStart));

      pageToken = shouldStopGoogleReviewPagination(pageReviews, reviewWindowStart)
        ? undefined
        : result.nextPageToken;
    } while (pageToken);

    const syncResult = await this.syncReviewRecords(gmb.id, allReviews);
    const totalReviewCount = allReviews.length;
    const averageRating =
      totalReviewCount > 0
        ? allReviews.reduce(
            (sum, review) => sum + this.normalizeRating(review.starRating),
            0,
          ) / totalReviewCount
        : undefined;

    return {
      reviews: allReviews,
      totalReviewCount,
      averageRating,
      newUnrespondedReviews: syncResult.newUnrespondedReviews,
    };
  }

  async respondToReview(
    businessId: string,
    reviewId: string,
    response: string,
  ): Promise<GMBReviewReplyResult> {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.accountId || !gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      return gmbDemoDataService.respondToDemoReview(
        businessId,
        reviewId,
        response,
      );
    }

    const token = await this.getValidToken(businessId);

    const review = await prisma.gMBReview.findFirst({
      where: {
        gmbId: gmb.id,
        reviewId,
      },
      select: {
        id: true,
        reviewId: true,
        isResponded: true,
        response: true,
        responseDate: true,
      },
    });

    if (!review) {
      throw new Error("Review not found for this Google Business Profile");
    }

    if (review.isResponded) {
      return {
        status: "already_responded_local",
        reviewId: review.reviewId,
        response: review.response ?? response,
        responseDate: review.responseDate?.toISOString() ?? null,
      };
    }

    const expectedPrefix = `accounts/${gmb.accountId}/locations/${gmb.locationId}/reviews/`;
    if (!review.reviewId.startsWith(expectedPrefix)) {
      throw new Error(
        "Review does not belong to the connected Google location",
      );
    }

    const responseDate = new Date();
    const claim = await prisma.gMBReview.updateMany({
      where: {
        id: review.id,
        isResponded: false,
      },
      data: {
        response,
        responseDate,
        isResponded: true,
      },
    });

    if (claim.count === 0) {
      const refreshedReview = await prisma.gMBReview.findFirst({
        where: {
          gmbId: gmb.id,
          reviewId,
        },
        select: {
          reviewId: true,
          response: true,
          responseDate: true,
          isResponded: true,
        },
      });

      return {
        status: "already_responded_local",
        reviewId: refreshedReview?.reviewId ?? review.reviewId,
        response: refreshedReview?.response ?? review.response ?? response,
        responseDate:
          refreshedReview?.responseDate?.toISOString() ??
          review.responseDate?.toISOString() ??
          null,
      };
    }

    try {
      await this.makeRequest<Record<string, unknown>>(
        `https://mybusiness.googleapis.com/v4/${review.reviewId}/reply`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ comment: response }),
        },
        "review",
      );

      return {
        status: "posted",
        reviewId: review.reviewId,
        response,
        responseDate: responseDate.toISOString(),
      };
    } catch (error) {
      if (isGMBNotFoundError(error)) {
        await this.rollbackReviewReplyClaim(review, response, responseDate);

        console.warn(
          `[GMB] Review ${review.reviewId} was not found remotely while posting a reply. Syncing reviews and marking it skipped if it remains unavailable.`,
        );

        await this.getReviews(businessId);

        const refreshedReview = await prisma.gMBReview.findFirst({
          where: {
            gmbId: gmb.id,
            reviewId,
          },
          select: {
            reviewId: true,
            response: true,
            responseDate: true,
            isResponded: true,
          },
        });

        if (refreshedReview?.isResponded) {
          return {
            status: "already_exists_remote",
            reviewId: refreshedReview.reviewId,
            response: refreshedReview.response ?? response,
            responseDate:
              refreshedReview.responseDate?.toISOString() ?? null,
          };
        }

        await prisma.gMBReview.updateMany({
          where: {
            id: review.id,
            isResponded: false,
          },
          data: {
            isResponded: true,
            response: null,
            responseDate: null,
          },
        });

        return {
          status: "not_found_remote",
          reviewId: review.reviewId,
          response: null,
          responseDate: null,
        };
      }

      if (!isGMBAlreadyExistsError(error)) {
        await this.rollbackReviewReplyClaim(review, response, responseDate);
        throw error;
      }

      console.warn(
        `[GMB] Review reply already exists remotely for ${review.reviewId}. Syncing reviews to reconcile local state.`,
      );

      await this.getReviews(businessId);

      const refreshedReview = await prisma.gMBReview.findFirst({
        where: {
          gmbId: gmb.id,
          reviewId,
        },
        select: {
          reviewId: true,
          response: true,
          responseDate: true,
          isResponded: true,
        },
      });

      if (refreshedReview?.isResponded) {
        return {
          status: "already_exists_remote",
          reviewId: refreshedReview.reviewId,
          response: refreshedReview.response ?? response,
          responseDate: refreshedReview.responseDate?.toISOString() ?? null,
        };
      }

      throw error;
    }
  }

  private async rollbackReviewReplyClaim(
    review: {
      id: string;
      response: string | null;
      responseDate: Date | null;
      isResponded: boolean;
    },
    claimedResponse: string,
    claimedResponseDate: Date,
  ) {
    await prisma.gMBReview.updateMany({
      where: {
        id: review.id,
        response: claimedResponse,
        responseDate: claimedResponseDate,
      },
      data: {
        response: review.response,
        responseDate: review.responseDate,
        isResponded: review.isResponded,
      },
    });
  }

  async getProfileDetails(
    businessId: string,
    providedToken?: string,
  ): Promise<GoogleLocation> {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      return gmbDemoDataService.getDemoProfileDetails(
        businessId,
      ) as Promise<GoogleLocation>;
    }

    const token = providedToken ?? await this.getValidToken(businessId);

    return this.getLocationDetailsWithToken(token, gmb.locationId);
  }

  async getPerformanceDailyMetrics(
    businessId: string,
    days = 90,
    providedToken?: string,
  ): Promise<GMBPerformanceDailyMetric[]> {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      return gmbDemoDataService.getDemoPerformanceDailyMetrics(
        businessId,
        days,
      );
    }

    const token = providedToken ?? await this.getValidToken(businessId);

    const params = this.getPerformanceDateRange(days);

    const result = await this.makeRequest<GooglePerformanceResponse>(
      `https://businessprofileperformance.googleapis.com/v1/locations/${gmb.locationId}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      "read",
    );

    return this.mapPerformanceResponseToDailyMetrics(result);
  }

  async getDiscoveryKeywordImpressions(
    businessId: string,
    months = 3,
    providedToken?: string,
  ): Promise<GMBDiscoveryKeywordMetric[]> {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      return gmbDemoDataService.getDemoDiscoveryKeywordImpressions(
        businessId,
        months,
      );
    }

    const token = providedToken ?? await this.getValidToken(businessId);

    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    start.setUTCMonth(start.getUTCMonth() - Math.max(1, Math.min(months, 18)) + 1);

    const params = new URLSearchParams();
    params.set("monthlyRange.startMonth.year", String(start.getUTCFullYear()));
    params.set("monthlyRange.startMonth.month", String(start.getUTCMonth() + 1));
    params.set("monthlyRange.endMonth.year", String(end.getUTCFullYear()));
    params.set("monthlyRange.endMonth.month", String(end.getUTCMonth() + 1));

    const result = await this.makeRequest<Record<string, unknown>>(
      `https://businessprofileperformance.googleapis.com/v1/locations/${gmb.locationId}/searchkeywords/impressions/monthly?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      "read",
    );

    const rows = (
      Array.isArray(result.searchKeywordsCounts)
        ? result.searchKeywordsCounts
        : Array.isArray(result.search_keywords_counts)
          ? result.search_keywords_counts
          : Array.isArray(result.monthlySearchKeywordsCounts)
            ? result.monthlySearchKeywordsCounts
            : []
    ) as Array<Record<string, unknown>>;

    return rows
      .map((row) => {
        const rawMonth =
          (row.month as { year?: number; month?: number } | undefined) ??
          (row.monthlyRange as { year?: number; month?: number } | undefined);
        const month = this.googleMonthToIso(rawMonth) ?? start.toISOString().slice(0, 10);
        const keyword =
          typeof row.searchKeyword === "string"
            ? row.searchKeyword
            : typeof row.keyword === "string"
              ? row.keyword
              : typeof row.query === "string"
                ? row.query
                : "";

        return {
          keyword: keyword.trim(),
          month,
          impressions: this.extractMetricValue(
            row.insightsValue ?? row.impressions ?? row.value ?? 0,
          ),
          raw: row,
        };
      })
      .filter((row) => row.keyword.length > 0);
  }

  async getInsights(businessId: string, providedToken?: string) {
    const dailyMetrics = await this.getPerformanceDailyMetrics(
      businessId,
      30,
      providedToken,
    );

    return {
      views: dailyMetrics.reduce(
        (sum, day) => sum + day.impressionsMaps + day.impressionsSearch,
        0,
      ),
      clicks: dailyMetrics.reduce((sum, day) => sum + day.websiteClicks, 0),
      calls: dailyMetrics.reduce((sum, day) => sum + day.callClicks, 0),
      directionRequests: dailyMetrics.reduce(
        (sum, day) => sum + day.directionRequests,
        0,
      ),
    };
  }

  async updateBusinessInfo(
    businessId: string,
    businessData: Record<string, unknown>,
  ) {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      return gmbDemoDataService.updateDemoProfileDetails(
        businessId,
        businessData,
      ) as Promise<GoogleLocation>;
    }

    const { payload, updateMask } = this.buildBusinessInformationPatch(
      businessData,
    );

    if (updateMask.length === 0) {
      throw new Error("No supported Google profile fields were provided");
    }

    const token = await this.getValidToken(businessId);
    const normalizedLocationId = this.normalizeLocationId(gmb.locationId);
    const params = new URLSearchParams();
    params.set("updateMask", updateMask.join(","));

    const result = await this.makeRequest<GoogleLocation>(
      `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${normalizedLocationId}?${params.toString()}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      "write",
    );

    return result;
  }

  async updateAttributes(
    businessId: string,
    input: {
      attributeMask: string[];
      attributes: Array<Record<string, unknown>>;
    },
  ) {
    const gmb = await this.getConnectionRecord(businessId);
    if (!gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }
    if (input.attributeMask.length === 0) {
      throw new Error("No supported Google attributes were provided");
    }

    if (isDemoGmbConnection(gmb)) {
      return gmbDemoDataService.updateDemoProfileDetails(businessId, {
        attributes: input.attributes,
      });
    }

    const token = await this.getValidToken(businessId);
    const normalizedLocationId = this.normalizeLocationId(gmb.locationId);
    const params = new URLSearchParams();
    params.set("attributeMask", input.attributeMask.join(","));
    const name = `locations/${normalizedLocationId}/attributes`;

    return this.makeRequest<Record<string, unknown>>(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${name}?${params.toString()}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, attributes: input.attributes }),
      },
      "write",
    );
  }

  private buildBusinessInformationPatch(businessData: Record<string, unknown>) {
    const payload: Record<string, unknown> = {};
    const updateMask: string[] = [];

    if (typeof businessData.name === "string" && businessData.name.trim()) {
      payload.title = businessData.name.trim();
      updateMask.push("title");
    }

    if (
      typeof businessData.phoneNumber === "string" &&
      businessData.phoneNumber.trim()
    ) {
      payload.phoneNumbers = {
        primaryPhone: businessData.phoneNumber.trim(),
      };
      updateMask.push("phoneNumbers");
    }

    if (
      typeof businessData.websiteUrl === "string" &&
      businessData.websiteUrl.trim()
    ) {
      payload.websiteUri = businessData.websiteUrl.trim();
      updateMask.push("websiteUri");
    }

    if (
      typeof businessData.description === "string" &&
      businessData.description.trim()
    ) {
      const description = businessData.description.trim();
      if (description.length > 750) {
        throw new Error(
          `Description exceeds Google's 750-character limit (${description.length} chars). Please shorten it before saving.`,
        );
      }
      payload.profile = {
        description,
      };
      updateMask.push("profile");
    }

    if (Array.isArray(businessData.categories)) {
      const validCategories = businessData.categories
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .map((c) => c.trim());
      if (validCategories.length > 0) {
        payload.categories = {
          primaryCategory: { name: validCategories[0] },
          ...(validCategories.length > 1
            ? {
                additionalCategories: validCategories
                  .slice(1, 10)
                  .map((name) => ({ name })),
              }
            : {}),
        };
        updateMask.push("categories");
      }
    }

    if (isRecord(businessData.regularHours)) {
      payload.regularHours = businessData.regularHours;
      updateMask.push("regularHours");
    }

    if (Array.isArray(businessData.specialHours)) {
      payload.specialHours = { specialHourPeriods: businessData.specialHours };
      updateMask.push("specialHours");
    } else if (isRecord(businessData.specialHours)) {
      payload.specialHours = businessData.specialHours;
      updateMask.push("specialHours");
    }

    if (isRecord(businessData.serviceArea)) {
      payload.serviceArea = businessData.serviceArea;
      updateMask.push("serviceArea");
    }

    if (Array.isArray(businessData.serviceItems)) {
      payload.serviceItems = businessData.serviceItems;
      updateMask.push("serviceItems");
    }

    if (Array.isArray(businessData.labels)) {
      payload.labels = businessData.labels;
      updateMask.push("labels");
    }

    return { payload, updateMask };
  }

  async uploadMedia(
    businessId: string,
    params: {
      sourceUrl: string;
      mediaFormat?: "PHOTO" | "VIDEO";
      category?: string;
      caption?: string;
    },
  ): Promise<{
    name?: string;
    googleUrl?: string;
    sourceUrl?: string;
    mediaFormat?: string;
  }> {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.accountId || !gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    const sourceUrl = (params.sourceUrl ?? "").trim();
    if (!sourceUrl) {
      throw new Error("Media sourceUrl is required");
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      throw new Error("Media sourceUrl must be a valid absolute URL");
    }
    if (parsedUrl.protocol !== "https:") {
      throw new Error("Media sourceUrl must use https:");
    }

    const allowedCategories = new Set([
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
    ]);
    const requestedCategory = (params.category ?? "ADDITIONAL").toUpperCase();
    const category = allowedCategories.has(requestedCategory)
      ? requestedCategory === "OTHER"
        ? "ADDITIONAL"
        : requestedCategory
      : "ADDITIONAL";

    const mediaFormat = params.mediaFormat ?? "PHOTO";

    if (mediaFormat === "PHOTO") {
      // Validate MIME and size before sending to Google. Google accepts JPEG/PNG
      // for photos with size between 10KB and 5MB. We use HEAD to read headers.
      try {
        const head = await fetch(sourceUrl, { method: "HEAD" });
        if (!head.ok) {
          throw new Error(
            `Media sourceUrl returned HTTP ${head.status}. Confirm the file is publicly accessible to Google.`,
          );
        }
        const contentType = head.headers.get("content-type") ?? "";
        const allowedMime = ["image/jpeg", "image/jpg", "image/png"];
        if (!allowedMime.some((mime) => contentType.toLowerCase().startsWith(mime))) {
          throw new Error(
            `Media sourceUrl returned content-type "${contentType}". Google requires image/jpeg or image/png.`,
          );
        }
        const contentLengthHeader = head.headers.get("content-length");
        const contentLength = contentLengthHeader
          ? Number.parseInt(contentLengthHeader, 10)
          : null;
        if (contentLength !== null && Number.isFinite(contentLength)) {
          const minBytes = 10 * 1024;
          const maxBytes = 5 * 1024 * 1024;
          if (contentLength < minBytes) {
            throw new Error(
              `Media file is too small (${contentLength} bytes). Google requires photos to be at least 10KB.`,
            );
          }
          if (contentLength > maxBytes) {
            throw new Error(
              `Media file is too large (${(contentLength / 1024 / 1024).toFixed(2)} MB). Google's photo limit is 5MB.`,
            );
          }
        }
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error("Failed to validate media sourceUrl before upload");
      }
    }

    if (isDemoGmbConnection(gmb)) {
      // Demo mode never hits Google.
      return {
        name: `accounts/${gmb.accountId}/locations/${gmb.locationId}/media/demo-${Date.now()}`,
        sourceUrl,
        googleUrl: sourceUrl,
        mediaFormat,
      };
    }

    const token = await this.getValidToken(businessId);
    const normalizedAccount = this.normalizeAccountId(gmb.accountId);
    const normalizedLocation = this.normalizeLocationId(gmb.locationId);

    const requestBody: Record<string, unknown> = {
      mediaFormat,
      locationAssociation: { category },
      sourceUrl,
    };
    if (params.caption) {
      requestBody.description = params.caption.slice(0, 1000);
    }

    const result = await this.makeRequest<{
      name?: string;
      googleUrl?: string;
      sourceUrl?: string;
      mediaFormat?: string;
    }>(
      `https://mybusiness.googleapis.com/v4/accounts/${normalizedAccount}/locations/${normalizedLocation}/media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      "write",
    );

    return result;
  }

  private async clearDisconnectedGmbCache(
    businessId: string,
    gmbId: string,
    disconnectedAt: Date,
  ) {
    await prisma.$transaction([
      prisma.gMBReviewAnalysis.deleteMany({ where: { businessId } }),
      prisma.gMBAISuggestion.deleteMany({ where: { businessId } }),
      prisma.gMBProfileProposalCache.deleteMany({ where: { businessId } }),
      prisma.gMBCategoryCacheEntry.deleteMany({ where: { businessId } }),
      prisma.gMBPostSuggestion.deleteMany({ where: { businessId } }),
      prisma.gMBAlert.deleteMany({ where: { businessId } }),
      prisma.gMBAttributionLink.deleteMany({ where: { businessId } }),
      prisma.gMBReviewCampaign.deleteMany({ where: { businessId } }),
      prisma.gMBCompetitorSnapshot.deleteMany({ where: { businessId } }),
      prisma.gMBLocalRankScan.deleteMany({ where: { businessId } }),
      prisma.gMBMediaAsset.deleteMany({ where: { businessId } }),
      prisma.gMBActionRecommendation.deleteMany({ where: { businessId } }),
      prisma.gMBProfileHealthRun.deleteMany({ where: { businessId } }),
      prisma.gMBDiscoveryKeyword.deleteMany({ where: { businessId } }),
      prisma.gMBDailyMetric.deleteMany({ where: { businessId } }),
      prisma.gMBProfileSnapshot.deleteMany({ where: { businessId } }),
      prisma.gMBPost.deleteMany({ where: { gmbId } }),
      prisma.gMBReview.deleteMany({ where: { gmbId } }),
      prisma.googleMyBusiness.update({
        where: { businessId },
        data: {
          isActive: false,
          isDemo: false,
          accessToken: "",
          refreshToken: "",
          tokenExpiry: disconnectedAt,
          accountId: null,
          accountName: null,
          locationId: null,
          locationName: null,
          placeId: null,
          businessName: null,
          businessAddress: null,
          businessPhone: null,
          businessWebsite: null,
          lastSyncAt: null,
          lastSyncError: null,
          totalReviewCount: null,
          cachedInsightsViews: null,
          cachedInsightsClicks: null,
          cachedInsightsCalls: null,
          cachedInsightsDirections: null,
          cachedAverageRating: null,
          cachedCategories: Prisma.JsonNull,
        },
      }),
    ]);
  }

  async disconnect(businessId: string) {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true },
    });

    if (!gmb) {
      throw new Error("Google My Business not connected");
    }

    await this.clearDisconnectedGmbCache(businessId, gmb.id, new Date());

    return {
      success: true,
      message: "Google My Business disconnected successfully",
    };
  }

  async getConnectionStatus(businessId: string): Promise<GMBConnectionStatus> {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: {
        businessId: true,
        accessToken: true,
        isActive: true,
        isDemo: true,
        accountId: true,
        accountName: true,
        locationId: true,
        locationName: true,
        businessName: true,
        businessAddress: true,
        businessPhone: true,
        businessWebsite: true,
        lastSyncAt: true,
        lastSyncError: true,
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: true,
        reviewReplyMode: true,
        profileEditMode: true,
        mediaPublishingMode: true,
        rankScanCadence: true,
        notificationPreferences: true,
      },
    });

    if (!gmb || !gmb.accessToken) {
      return {
        state: "disconnected",
        health: assessGmbConnectionHealth({
          accessTokenPresent: false,
          isActive: false,
          accountId: null,
          locationId: null,
          lastSyncAt: null,
          lastSyncError: null,
        }),
      };
    }

    if (gmb.isDemo && !isGmbDemoModeEnabled()) {
      return {
        state: "disconnected",
        health: assessGmbConnectionHealth({
          accessTokenPresent: false,
          isActive: false,
          accountId: null,
          locationId: null,
          lastSyncAt: gmb.lastSyncAt,
          lastSyncError: null,
        }),
      };
    }

    if (gmb.isActive && gmb.accountId && gmb.locationId) {
      return this.buildConnectedStatus(gmb);
    }

    const storedHealth = assessGmbConnectionHealth({
      accessTokenPresent: true,
      isActive: gmb.isActive,
      accountId: gmb.accountId,
      locationId: gmb.locationId,
      lastSyncAt: gmb.lastSyncAt,
      lastSyncError: gmb.lastSyncError,
    });
    if (storedHealth.state === "reconnect_required") {
      return {
        state: "reconnect_required",
        businessId,
        lastSyncAt: storedHealth.lastSyncAt,
        lastSyncError: getPublicGmbConnectionIssue(storedHealth.state),
        health: storedHealth,
      };
    }

    try {
      const token = await this.getValidToken(businessId, {
        requireActive: false,
      });
      const candidates = await this.buildLocationCandidatesFromToken(token);

      return {
        state: "pending_location_selection",
        businessId,
        candidates,
        lastSyncError:
          candidates.length === 0
            ? "No accessible Google Business Profile locations were found."
            : getPublicGmbConnectionIssue(storedHealth.state),
        health: storedHealth,
      };
    } catch (error) {
      console.error(
        "Failed to resolve pending GMB location candidates:",
        error,
      );
      const lastSyncError =
        error instanceof Error ? error.message : gmb.lastSyncError;
      const failedHealth = assessGmbConnectionHealth({
        accessTokenPresent: true,
        isActive: false,
        accountId: gmb.accountId,
        locationId: gmb.locationId,
        lastSyncAt: gmb.lastSyncAt,
        lastSyncError,
      });
      if (failedHealth.state === "reconnect_required") {
        return {
          state: "reconnect_required",
          businessId,
          lastSyncAt: failedHealth.lastSyncAt,
          lastSyncError: getPublicGmbConnectionIssue(failedHealth.state),
          health: failedHealth,
        };
      }
      return {
        state: "pending_location_selection",
        businessId,
        candidates: [],
        lastSyncError:
          getPublicGmbConnectionIssue(failedHealth.state) ??
          "Google Business Profile setup could not be verified. Try again.",
        health: failedHealth,
      };
    }
  }

  async syncDashboardData(businessId: string, forceSync = false): Promise<GMBDashboardData> {
    const gmb = await this.getConnectionRecord(businessId);

    if (!gmb.accountId || !gmb.locationId) {
      throw new Error(GMB_RECONNECT_REQUIRED_MESSAGE);
    }

    if (isDemoGmbConnection(gmb)) {
      if (forceSync) {
        await gmbDemoDataService.resetDemoBusiness(businessId);
      }
      const cached = await this.getCachedDashboardData(businessId);
      if (cached) {
        return { ...cached, source: "cache" };
      }
      throw new Error("GMB demo data is not seeded");
    }

    const SYNC_INTERVAL_MS = 15 * 60 * 1000;
    const lastSync = gmb.lastSyncAt ? new Date(gmb.lastSyncAt).getTime() : 0;
    const isFresh = Date.now() - lastSync < SYNC_INTERVAL_MS;

    console.log(
      `[GMB Sync] businessId=${businessId} forceSync=${forceSync} isFresh=${isFresh} lastSync=${gmb.lastSyncAt?.toISOString() ?? "never"} lastError=${gmb.lastSyncError ?? "none"}`,
    );

    if (!forceSync && isFresh) {
      console.log(`[GMB Sync] Returning cached data (fresh within 15min window)`);
      const cached = await this.getCachedDashboardData(businessId);
      if (cached) {
        return cached;
      }
    }

    console.log(`[GMB Sync] Performing live sync from Google API`);
    try {
      const token = await this.getValidToken(businessId);
      const [profile, postsResponse, reviewsResponse] = await Promise.all([
        this.getLocationDetailsWithToken(token, gmb.locationId),
        this.getPosts(businessId, undefined, token),
        this.getReviews(businessId, undefined, token),
      ]);

      const insights = await this.getInsights(businessId, token).catch((error) => {
        console.error("Failed to sync GMB insights:", error);
        return {
          views: 0,
          clicks: 0,
          calls: 0,
          directionRequests: 0,
        };
      });

      await this.syncPostRecords(gmb.id, postsResponse.localPosts ?? []);
      const cachedPosts = await this.getCachedPosts(businessId);
      const cachedReviews = await this.getCachedReviews(businessId);

      const rating: number | null =
        typeof reviewsResponse.averageRating === "number"
          ? Number(reviewsResponse.averageRating.toFixed(1))
          : cachedReviews.length > 0
            ? Number(
                (
                  cachedReviews.reduce((sum, review) => sum + review.rating, 0) /
                  cachedReviews.length
                ).toFixed(1),
              )
            : null;

      const totalReviews: number =
        typeof reviewsResponse.totalReviewCount === "number"
          ? reviewsResponse.totalReviewCount
          : cachedReviews.length;

      const totalPosts = cachedPosts.length;
      const syncedAt = new Date();

      await this.updateSyncStatus(businessId, {
        lastSyncAt: syncedAt,
        lastSyncError: null,
        businessName: profile.title ?? gmb.businessName,
        businessAddress:
          this.formatAddress(profile.storefrontAddress) ?? gmb.businessAddress,
        businessPhone: profile.phoneNumbers?.primaryPhone ?? gmb.businessPhone,
        businessWebsite: profile.websiteUri ?? gmb.businessWebsite,
        locationName: profile.title ?? gmb.locationName,
        placeId:
          typeof profile.metadata?.placeId === "string"
            ? profile.metadata.placeId
            : gmb.placeId,
        totalReviewCount: totalReviews,
        cachedInsightsViews: insights.views,
        cachedInsightsClicks: insights.clicks,
        cachedInsightsCalls: insights.calls,
        cachedInsightsDirections: insights.directionRequests,
        cachedAverageRating: rating,
        cachedCategories: this.extractCategories(profile),
      });

      console.log(
        `[GMB Sync] Live sync successful. posts=${totalPosts} reviews=${totalReviews} rating=${rating}`,
      );

      // D5: cascade into BusinessGeoProfile so GMB-connected customers get
      // their Place ID + neighborhood + landmarks populated for free (no
      // picker interaction required). v1 Business Info sometimes exposes a
      // metadata.placeId — if present, pass it through to skip the search
      // step entirely; otherwise enrichGeoProfile() will fall back to
      // searchText using the canonical business name + address.
      if (process.env.GOOGLE_MAPS_API_KEY) {
        const gmbPlaceId =
          typeof (profile as unknown as { metadata?: { placeId?: string } })
            .metadata?.placeId === "string"
            ? (profile as unknown as { metadata?: { placeId?: string } })
                .metadata?.placeId
            : undefined;
        void import("./business-geo-profile.service").then(
          ({ enrichGeoProfile, recomputeGeoProfileQuality }) =>
            Promise.all([
              enrichGeoProfile(businessId, gmbPlaceId),
              recomputeGeoProfileQuality(businessId),
            ]).catch((err) => {
              console.error(
                "[GMB Sync] geo-profile cascade failed:",
                (err as Error).message,
              );
            }),
        );
      }

      return {
        profile: {
          businessName: profile.title ?? gmb.businessName,
          businessAddress:
            this.formatAddress(profile.storefrontAddress) ??
            gmb.businessAddress,
          businessPhone:
            profile.phoneNumbers?.primaryPhone ?? gmb.businessPhone,
          businessWebsite: profile.websiteUri ?? gmb.businessWebsite,
          verified: null,
          rating,
          totalReviews,
          totalPosts,
          categories: this.extractCategories(profile),
        },
        posts: cachedPosts.map((post) => this.mapCachedPost(post)),
        reviews: cachedReviews.map((review) => ({
          id: review.id,
          reviewId: review.reviewId,
          reviewerName: review.reviewerName,
          reviewerPhoto: review.reviewerPhoto,
          rating: review.rating,
          comment: review.comment,
          reviewDate: review.reviewDate.toISOString(),
          response: review.response,
          responseDate: review.responseDate?.toISOString() ?? null,
          isResponded: review.isResponded,
        })),
        settings: {
          autoPostToGmbEnabled: gmb.autoPostToGmbEnabled,
          autoReviewReplyEnabled: gmb.autoReviewReplyEnabled,
          postAutomationMode: this.normalizePostAutomationMode(
            gmb.postAutomationMode,
          ),
          reviewReplyMode: this.normalizePublishingMode(gmb.reviewReplyMode),
          profileEditMode: this.normalizeEditMode(gmb.profileEditMode),
          mediaPublishingMode: this.normalizePublishingMode(
            gmb.mediaPublishingMode,
          ),
          rankScanCadence: this.normalizeRankScanCadence(gmb.rankScanCadence),
          notificationPreferences:
            this.normalizeNotificationPreferences(gmb.notificationPreferences),
        },
        insights,
        syncedAt: syncedAt.toISOString(),
        source: "live",
      };
    } catch (error) {
      console.error("[GMB Sync] Failed to sync dashboard data:", error);

      const fallback = await this.getCachedDashboardData(businessId);
      if (fallback) {
        await this.updateSyncStatus(businessId, {
          lastSyncAt: new Date(),
          lastSyncError: error instanceof Error ? error.message : "Sync failed",
        });
        return { ...fallback, source: "error" as const };
      }

      throw error;
    }
  }

  async getCachedPosts(businessId: string) {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true },
    });

    if (!gmb) {
      return [];
    }

    return prisma.gMBPost.findMany({
      where: { gmbId: gmb.id },
      orderBy: { createdAt: "desc" },
    });
  }

  async getCachedReviews(businessId: string) {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true },
    });

    if (!gmb) {
      return [];
    }

    return prisma.gMBReview.findMany({
      where: {
        gmbId: gmb.id,
        reviewDate: { gte: getGmbReviewWindowStart() },
      },
      orderBy: { reviewDate: "desc" },
    });
  }

  private async getCachedDashboardData(
    businessId: string,
  ): Promise<GMBDashboardData | null> {
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: {
        businessName: true,
        businessAddress: true,
        businessPhone: true,
        businessWebsite: true,
        lastSyncAt: true,
        lastSyncError: true,
        totalReviewCount: true,
        cachedInsightsViews: true,
        cachedInsightsClicks: true,
        cachedInsightsCalls: true,
        cachedInsightsDirections: true,
        cachedAverageRating: true,
        cachedCategories: true,
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: true,
        reviewReplyMode: true,
        profileEditMode: true,
        mediaPublishingMode: true,
        rankScanCadence: true,
        notificationPreferences: true,
      },
    });

    if (!gmb) {
      return null;
    }

    const [cachedPosts, cachedReviews] = await Promise.all([
      this.getCachedPosts(businessId),
      this.getCachedReviews(businessId),
    ]);

    if (
      cachedPosts.length === 0 &&
      cachedReviews.length === 0 &&
      !gmb.businessName
    ) {
      return null;
    }

    const rating: number | null =
      cachedReviews.length > 0
        ? Number(
            (
              cachedReviews.reduce((sum, review) => sum + review.rating, 0) /
              cachedReviews.length
            ).toFixed(1),
          )
        : null;

    const totalReviews = cachedReviews.length;

    const categories: string[] = Array.isArray(gmb.cachedCategories)
      ? (gmb.cachedCategories as string[])
      : [];

    return {
      profile: {
        businessName: gmb.businessName,
        businessAddress: gmb.businessAddress,
        businessPhone: gmb.businessPhone,
        businessWebsite: gmb.businessWebsite,
        verified: null,
        rating,
        totalReviews,
        totalPosts: cachedPosts.length,
        categories,
      },
      posts: cachedPosts.map((post) => this.mapCachedPost(post)),
      reviews: cachedReviews.map((review) => ({
        id: review.id,
        reviewId: review.reviewId,
        reviewerName: review.reviewerName,
        reviewerPhoto: review.reviewerPhoto,
        rating: review.rating,
        comment: review.comment,
        reviewDate: review.reviewDate.toISOString(),
        response: review.response,
        responseDate: review.responseDate?.toISOString() ?? null,
        isResponded: review.isResponded,
      })),
        settings: {
          autoPostToGmbEnabled: gmb.autoPostToGmbEnabled,
          autoReviewReplyEnabled: gmb.autoReviewReplyEnabled,
          postAutomationMode: this.normalizePostAutomationMode(
            gmb.postAutomationMode,
          ),
          reviewReplyMode: this.normalizePublishingMode(gmb.reviewReplyMode),
          profileEditMode: this.normalizeEditMode(gmb.profileEditMode),
          mediaPublishingMode: this.normalizePublishingMode(
            gmb.mediaPublishingMode,
          ),
          rankScanCadence: this.normalizeRankScanCadence(gmb.rankScanCadence),
          notificationPreferences:
            this.normalizeNotificationPreferences(gmb.notificationPreferences),
        },
      insights: {
        views: gmb.cachedInsightsViews ?? 0,
        clicks: gmb.cachedInsightsClicks ?? 0,
        calls: gmb.cachedInsightsCalls ?? 0,
        directionRequests: gmb.cachedInsightsDirections ?? 0,
      },
      syncedAt: gmb.lastSyncAt?.toISOString() ?? new Date().toISOString(),
      source: gmb.lastSyncError ? "error" : "cache",
    };
  }

  private mapCachedPost(post: CachedGMBPost) {
    if (!post) {
      throw new Error("Post could not be loaded after creation");
    }

    return {
      id: post.id,
      postId: post.postId,
      postType: post.postType as "UPDATE" | "EVENT" | "OFFER" | "PRODUCT",
      title: post.title,
      summary: post.summary,
      callToAction: post.callToAction,
      mediaUrls: post.mediaUrls,
      status: post.status as "DRAFT" | "PUBLISHED" | "FAILED",
      publishedAt: post.publishedAt?.toISOString() ?? null,
    };
  }

  private async upsertPostRecord(
    gmbId: string,
    post: GoogleLocalPost,
    fallbackTitle?: string,
  ) {
    const existing = post.name
      ? await prisma.gMBPost.findFirst({
          where: {
            gmbId,
            postId: post.name,
          },
          select: { id: true, title: true },
        })
      : null;

    const data = {
      gmbId,
      postId: post.name ?? null,
      postType: this.normalizePostType(post.topicType),
      title: fallbackTitle ?? existing?.title ?? null,
      summary: post.summary ?? null,
      callToAction: post.callToAction?.url ?? null,
      mediaUrls:
        post.media
          ?.map((media) => media.sourceUrl || media.googleUrl)
          .filter((value): value is string => Boolean(value)) ?? [],
      status: "PUBLISHED" as const,
      publishedAt: post.createTime ? new Date(post.createTime) : new Date(),
    };

    if (existing) {
      return prisma.gMBPost.update({
        where: { id: existing.id },
        data,
      });
    }

    return prisma.gMBPost.create({ data });
  }

  private async syncPostRecords(gmbId: string, posts: GoogleLocalPost[]) {
    for (const post of posts) {
      await this.upsertPostRecord(gmbId, post);
    }
  }

  private async syncReviewRecords(gmbId: string, reviews: GoogleReview[]): Promise<{
    newUnrespondedReviews: Array<{
      id: string;
      reviewId: string;
      reviewerName: string;
      rating: number;
      comment: string | null;
    }>;
  }> {
    const validReviews = reviews.filter(
      (r): r is GoogleReview & { name: string } => Boolean(r.name),
    );

    if (validReviews.length === 0) {
      return { newUnrespondedReviews: [] };
    }

    const existingRecords = await prisma.gMBReview.findMany({
      where: { reviewId: { in: validReviews.map((r) => r.name) } },
      select: {
        reviewId: true,
        response: true,
        responseDate: true,
        isResponded: true,
      },
    });
    const existingByReviewId = new Map(
      existingRecords.map((record) => [record.reviewId, record]),
    );

    type UnrespondedReview = {
      id: string;
      reviewId: string;
      reviewerName: string;
      rating: number;
      comment: string | null;
    };

    const newUnrespondedReviews: UnrespondedReview[] = [];
    const BATCH_SIZE = 15;

    for (let i = 0; i < validReviews.length; i += BATCH_SIZE) {
      const batch = validReviews.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map((review) => {
          const existing = existingByReviewId.get(review.name);
          const isNew = !existing;
          const remoteResponse = review.reviewReply?.comment ?? null;
          const remoteResponseDate = review.reviewReply?.updateTime
            ? new Date(review.reviewReply.updateTime)
            : null;
          const hasNoResponse = !remoteResponse;
          const reviewData = {
            reviewerName: review.reviewer?.displayName || "Anonymous",
            reviewerPhoto: review.reviewer?.profilePhotoUrl ?? null,
            rating: this.normalizeRating(review.starRating),
            comment: review.comment ?? null,
            reviewDate: review.createTime
              ? new Date(review.createTime)
              : new Date(),
            response:
              remoteResponse ??
              (existing?.isResponded ? existing.response : null),
            responseDate:
              remoteResponseDate ??
              (existing?.isResponded ? existing.responseDate : null),
            isResponded:
              Boolean(remoteResponse) || Boolean(existing?.isResponded),
          };

          return prisma.gMBReview
            .upsert({
              where: { reviewId: review.name },
              update: reviewData,
              create: { gmbId, reviewId: review.name, ...reviewData },
            })
            .then((record) => ({ record, isNew, hasNoResponse }));
        }),
      );

      for (const { record, isNew, hasNoResponse } of results) {
        if (isNew && hasNoResponse) {
          newUnrespondedReviews.push({
            id: record.id,
            reviewId: record.reviewId,
            reviewerName: record.reviewerName,
            rating: record.rating,
            comment: record.comment,
          });
        }
      }
    }

    return { newUnrespondedReviews };
  }

  async autoReplyToNewReviews(
    businessId: string,
    newUnrespondedReviews: Array<{
      id: string;
      reviewId: string;
      reviewerName: string;
      rating: number;
      comment: string | null;
    }>
  ): Promise<{
    repliedCount: number;
    skippedCount: number;
    failedCount: number;
    results: Array<{
      reviewId: string;
      success: boolean;
      status: "posted" | "skipped" | "failed";
      error?: string;
    }>;
  }> {
    const { gmbAIService } = await import("./gmb-ai.service");

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { businessName: true, businessType: true },
    });

    if (!business) {
      throw new Error("Business not found");
    }

    const results: Array<{
      reviewId: string;
      success: boolean;
      status: "posted" | "skipped" | "failed";
      error?: string;
    }> = [];
    let repliedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const review of newUnrespondedReviews) {
      try {
        const aiResponse = await gmbAIService.generateReviewResponse({
          reviewerName: review.reviewerName,
          rating: review.rating,
          comment: review.comment,
          businessName: business.businessName,
          businessType: business.businessType,
          reviewId: review.reviewId,
        });

        const replyResult = await this.respondToReview(
          businessId,
          review.reviewId,
          aiResponse.response
        );

        results.push({
          reviewId: review.reviewId,
          success: true,
          status: replyResult.status === "posted" ? "posted" : "skipped",
        });
        if (replyResult.status === "posted") {
          repliedCount++;
          console.log(
            `[GMB Auto-Reply] Successfully replied to review ${review.reviewId} (rating: ${review.rating}, intent: ${aiResponse.intent})`
          );
        } else {
          skippedCount++;
          console.log(
            `[GMB Auto-Reply] Review ${review.reviewId} already had a reply. Local state was reconciled without reposting.`
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        results.push({
          reviewId: review.reviewId,
          success: false,
          status: "failed",
          error: errorMessage,
        });
        failedCount++;
        console.error(
          `[GMB Auto-Reply] Failed to reply to review ${review.reviewId}:`,
          error
        );
      }
    }

    return { repliedCount, skippedCount, failedCount, results };
  }

  async syncAndAutoReplyReviews(businessId: string): Promise<{
    syncedCount: number;
    autoReplyDisabled: boolean;
    autoReplyResults: {
      repliedCount: number;
      skippedCount: number;
      failedCount: number;
      results: Array<{
        reviewId: string;
        success: boolean;
        status: "posted" | "skipped" | "failed";
        error?: string;
      }>;
    } | null;
  }> {
    const reviewsResult = await this.getReviews(businessId);
    const reviews = reviewsResult.reviews ?? [];
    const autoReviewReplyEnabled = await this.isAutoReviewReplyEnabled(businessId);

    let autoReplyResults = null;
    if (!autoReviewReplyEnabled) {
      console.log(
        `[GMB Auto-Reply] Auto-reply disabled for business ${businessId}; synced reviews without posting replies.`,
      );
    } else {
      const unrespondedReviewIds = reviews
        .filter(
          (review): review is GoogleReview & { name: string } =>
            Boolean(review.name) && !review.reviewReply?.comment,
        )
        .map((review) => review.name);
      const unrespondedReviews =
        unrespondedReviewIds.length > 0
          ? await prisma.gMBReview.findMany({
              where: {
                reviewId: { in: unrespondedReviewIds },
                isResponded: false,
              },
              select: {
                id: true,
                reviewId: true,
                reviewerName: true,
                rating: true,
                comment: true,
              },
              orderBy: { reviewDate: "desc" },
            })
          : [];

      if (unrespondedReviews.length > 0) {
        console.log(
          `[GMB Auto-Reply] Found ${unrespondedReviews.length} unresponded reviews for business ${businessId}`,
        );
        autoReplyResults = await this.autoReplyToNewReviews(
          businessId,
          unrespondedReviews,
        );
      }
    }

    return {
      syncedCount: reviews.length,
      autoReplyDisabled: !autoReviewReplyEnabled,
      autoReplyResults,
    };
  }
}
