import type { Response } from "express";
import { z, ZodError } from "zod";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  GMBPostSuggestionSetupError,
  gmbAIService,
} from "../services/gmb-ai.service";
import { gmbDemoDataService } from "../services/gmb-demo-data.service";
import {
  gmbLocalVisibilityService,
  GMBRankScanThrottledError,
} from "../services/gmb-local-visibility.service";
import { GoogleMyBusinessService } from "../services/google-my-business.service";
import { getGmbReviewWindowStart } from "../utils/gmb-review-window.utils";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import { invalidateTenantCache } from "../utils/tenant-response-cache";
import {
  isGoogleOAuthStateConfigured,
  signGoogleOAuthState,
  verifyGoogleOAuthState,
} from "../utils/google-oauth-state";
import {
  CONNECT_GMB,
  CREATE_GMB_POST,
  DISCONNECT_GMB,
  DISMISS_POST_SUGGESTION,
  GENERATE_REVIEW_RESPONSE,
  GMB_ACTION_MUTATION,
  GMB_ACTIONS,
  GET_GMB_ACCOUNTS,
  GET_GMB_INSIGHTS,
  GET_GMB_LOCATIONS,
  GET_GMB_POSTS,
  GET_GMB_REVIEWS,
  GMB_AI_SUGGESTIONS,
  GMB_BUSINESS_SCOPED,
  GMB_DISCOVERY_KEYWORDS,
  GMB_DEMO_MODE,
  GMB_MEDIA,
  GMB_METRICS_TIMESERIES,
  GMB_POST_SUGGESTIONS,
  GMB_PROFILE_HEALTH,
  GMB_RANK_SCANS,
  GMB_REVIEW_CAMPAIGNS,
  GMB_REVIEW_CAMPAIGN_IMPORT,
  GMB_REVIEW_CAMPAIGN_ACTIVATE,
  GMB_REVIEW_ANALYSIS,
  PUBLISH_POST_SUGGESTION,
  RESPOND_TO_REVIEW,
  SCHEDULE_POST_SUGGESTION,
  SELECT_GMB_LOCATION,
  SYNC_GMB,
  UPDATE_GMB_SETTINGS,
  UPDATE_BUSINESS_INFO,
} from "../validators/google-my-business.validation";

const gmbService = new GoogleMyBusinessService();

const OAUTH_START = z.object({
  businessId: z.string().min(1).max(128),
  redirectUri: z.string().url().max(2_048),
});
const OAUTH_CALLBACK = z.object({
  code: z.string().min(1).max(4_096),
  state: z.string().min(1).max(4_096),
});

function getErrorStatus(error: unknown, fallback = 500) {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : fallback;
}

function getAuthenticatedUserId(
  req: AuthenticatedRequest,
  res: Response
): string | null {
  if (!req.authUserId) {
    sendError(res, "Unauthorized", 401);
    return null;
  }

  return req.authUserId;
}

async function getAuthorizedBusinessId(
  userId: string,
  businessId: string | undefined,
  res: Response
): Promise<string | null> {
  const business = businessId
    ? await prisma.business.findFirst({
        where: {
          id: businessId,
          userId,
          isActive: true,
        },
        select: { id: true },
      })
    : await prisma.business.findFirst({
        where: {
          userId,
          isActive: true,
        },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      });

  if (!business) {
    sendError(res, "Business not found", 404);
    return null;
  }

  return business.id;
}

async function completeGmbOAuth(
  businessId: string,
  code: string,
  redirectUri: string,
) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error("Failed to exchange OAuth authorization code");
  }

  const tokens = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token || !tokens.expires_in) {
    throw new Error("OAuth token response was incomplete");
  }

  return gmbService.completeOAuthConnection(businessId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  });
}

export async function startGmbOAuth(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = OAUTH_START.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;
    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res,
    );
    if (!businessId) return;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || !isGoogleOAuthStateConfigured()) {
      return sendError(res, "Connection is temporarily unavailable", 503);
    }
    const state = signGoogleOAuthState({
      provider: "gmb",
      userId,
      businessId,
      redirectUri: payload.redirectUri,
    });
    if (!state) {
      return sendError(res, "Connection request is invalid", 400);
    }

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: payload.redirectUri,
      scope: "https://www.googleapis.com/auth/business.manage",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return sendSuccess(res, { url: url.toString() }, "Connection ready");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    return sendError(res, "Could not start connection", 500, error);
  }
}

export async function completeGmbOAuthCallback(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = OAUTH_CALLBACK.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;
    const state = verifyGoogleOAuthState(payload.state, "gmb");
    if (!state || state.userId !== userId) {
      return sendError(res, "Connection request is invalid", 403);
    }
    const businessId = await getAuthorizedBusinessId(
      userId,
      state.businessId,
      res,
    );
    if (!businessId) return;

    const connectionStatus = await completeGmbOAuth(
      businessId,
      payload.code,
      state.redirectUri,
    );
    await invalidateTenantCache(userId, businessId);
    return sendSuccess(
      res,
      { ...connectionStatus, businessId },
      "Google Business Profile connected",
    );
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    return sendError(res, "Could not complete connection", 500, error);
  }
}

export async function connectGMB(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = CONNECT_GMB.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const connectionStatus = await completeGmbOAuth(
      businessId,
      payload.code,
      payload.redirectUri,
    );
    await invalidateTenantCache(userId, businessId);

    return sendSuccess(
      res,
      connectionStatus,
      "Google My Business connected successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("GMB connection error:", error);
    return sendError(res, "Failed to connect Google My Business", 500, error);
  }
}

export async function connectGMBDemo(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_DEMO_MODE.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    await gmbDemoDataService.connectDemoBusiness(businessId);
    await invalidateTenantCache(userId, businessId);
    const status = await gmbService.getConnectionStatus(businessId);
    return sendSuccess(res, status, "GMB demo data connected");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Connect GMB demo error:", error);
    return sendError(
      res,
      error instanceof Error ? error.message : "Failed to connect GMB demo data",
      getErrorStatus(error),
      error,
    );
  }
}

export async function resetGMBDemo(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_DEMO_MODE.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    await gmbDemoDataService.resetDemoBusiness(businessId);
    const dashboard = await gmbService.syncDashboardData(businessId);
    await invalidateTenantCache(userId, businessId);
    return sendSuccess(res, dashboard, "GMB demo data reset");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Reset GMB demo error:", error);
    return sendError(
      res,
      error instanceof Error ? error.message : "Failed to reset GMB demo data",
      getErrorStatus(error),
      error,
    );
  }
}

export async function disconnectGMBDemo(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_DEMO_MODE.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbDemoDataService.disconnectDemoBusiness(businessId);
    await invalidateTenantCache(userId, businessId);
    return sendSuccess(res, result, "GMB demo data disconnected");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Disconnect GMB demo error:", error);
    return sendError(
      res,
      error instanceof Error ? error.message : "Failed to disconnect GMB demo data",
      getErrorStatus(error),
      error,
    );
  }
}

export async function selectGMBLocation(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = SELECT_GMB_LOCATION.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const connectionStatus = await gmbService.selectLocation(businessId, {
      accountId: payload.accountId,
      accountName: payload.accountName,
      locationId: payload.locationId,
      locationName: payload.locationName,
      address: payload.address,
    });
    await invalidateTenantCache(userId, businessId);

    return sendSuccess(
      res,
      connectionStatus,
      "Google My Business location selected successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Select GMB location error:", error);
    return sendError(res, "Failed to select GMB location", 500, error);
  }
}

export async function syncGMB(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = SYNC_GMB.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const dashboardData = await gmbService.syncDashboardData(businessId, payload.forceSync ?? false);
    await invalidateTenantCache(userId, businessId);

    return sendSuccess(
      res,
      dashboardData,
      "Google My Business dashboard synced successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Sync GMB error:", error);
    return sendError(res, "Failed to sync Google My Business data", 500, error);
  }
}

export async function getGMBAccounts(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GET_GMB_ACCOUNTS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const accounts = await gmbService.getAccounts(businessId);
    return sendSuccess(res, accounts, "GMB accounts retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB accounts error:", error);
    return sendError(res, "Failed to get GMB accounts", 500, error);
  }
}

export async function getGMBLocations(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GET_GMB_LOCATIONS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const locations = await gmbService.getLocations(businessId, payload.accountId);
    return sendSuccess(res, locations, "GMB locations retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB locations error:", error);
    return sendError(res, "Failed to get GMB locations", 500, error);
  }
}

export async function createGMBPost(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = CREATE_GMB_POST.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    let mediaUrls = payload.mediaUrls || [];

    if (mediaUrls.length === 0) {
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { businessName: true, businessType: true },
      });

      if (business) {
        const { imageGenerationService } = await import(
          "../services/image-generation.service"
        );
        const imageResult = await imageGenerationService.generateGMBPostImage(
          business.businessName,
          payload.title || payload.summary.substring(0, 50),
          payload.postType,
          business.businessType || undefined,
          payload.summary || undefined
        );

        if (imageResult.success && imageResult.imageUrl) {
          mediaUrls = [imageResult.imageUrl];
          console.log(
            `[GMB Post] Auto-generated image for post: ${imageResult.imageUrl}`
          );
        } else {
          console.warn(
            `[GMB Post] Failed to auto-generate image: ${imageResult.error}`
          );
        }
      }
    }

    const post = await gmbService.createPost(businessId, {
      postType: payload.postType,
      summary: payload.summary,
      callToAction: payload.callToAction,
      mediaUrls,
      title: payload.title,
    });

    return sendSuccess(res, post, "GMB post created successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Create GMB post error:", error);
    return sendError(res, "Failed to create GMB post", 500, error);
  }
}

export async function getGMBPosts(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GET_GMB_POSTS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const posts = await gmbService.getPosts(businessId, payload.locationId);
    return sendSuccess(res, posts, "GMB posts retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB posts error:", error);
    return sendError(res, "Failed to get GMB posts", 500, error);
  }
}

export async function getGMBReviews(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GET_GMB_REVIEWS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const reviews = await gmbService.getReviews(businessId, payload.locationId);
    return sendSuccess(res, reviews, "GMB reviews retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB reviews error:", error);
    return sendError(res, "Failed to get GMB reviews", 500, error);
  }
}

export async function respondToGMBReview(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = RESPOND_TO_REVIEW.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const result = await gmbService.respondToReview(
      businessId,
      payload.reviewId,
      payload.response
    );

    return sendSuccess(res, result, "Review response processed successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Respond to GMB review error:", error);
    return sendError(res, "Failed to respond to review", 500, error);
  }
}

export async function getGMBInsights(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GET_GMB_INSIGHTS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const insights = await gmbService.getInsights(businessId);
    return sendSuccess(res, insights, "GMB insights retrieved successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB insights error:", error);
    return sendError(res, "Failed to get GMB insights", 500, error);
  }
}

export async function updateBusinessInfo(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = UPDATE_BUSINESS_INFO.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const settings = await gmbService.getAutomationSettings(businessId);
    if (settings.profileEditMode === "disabled") {
      return sendError(res, "Google profile edits are disabled", 403);
    }

    const result = await gmbLocalVisibilityService.queueProfileEditAction(
      businessId,
      payload.businessData,
    );

    return sendSuccess(
      res,
      result,
      "Business information change queued for approval"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Update business info error:", error);
    return sendError(res, "Failed to update business information", 500, error);
  }
}

export async function getGMBConnectionStatus(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const status = await gmbService.getConnectionStatus(businessId);
    console.info(
      `[gmb-status] businessId=${businessId} state=${status.state} health=${status.health?.state ?? "unknown"}`,
    );
    return sendSuccess(res, status, "GMB connection status retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB connection status error:", error);
    return sendError(res, "Failed to get connection status", 500, error);
  }
}

export async function getGMBSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const settings = await gmbService.getAutomationSettings(businessId);
    return sendSuccess(res, settings, "GMB settings retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    if (
      error instanceof Error &&
      error.message === "Google My Business not connected"
    ) {
      return sendError(
        res,
        "Connect Google Business Profile to configure post publishing",
        409,
      );
    }

    console.error("Get GMB settings error:", error);
    return sendError(res, "Failed to get GMB settings", 500, error);
  }
}

export async function updateGMBSettings(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = UPDATE_GMB_SETTINGS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const requestedSettings = {
      autoPostToGmbEnabled: payload.autoPostToGmbEnabled,
      autoReviewReplyEnabled: payload.autoReviewReplyEnabled,
      postAutomationMode: payload.postAutomationMode,
      reviewReplyMode: payload.reviewReplyMode,
      profileEditMode: payload.profileEditMode,
      mediaPublishingMode: payload.mediaPublishingMode,
      rankScanCadence: payload.rankScanCadence,
      notificationPreferences: payload.notificationPreferences,
    };

    const settings = await gmbService.updateAutomationSettings(
      businessId,
      Object.fromEntries(
        Object.entries(requestedSettings).filter(
          ([, value]) => value !== undefined,
        ),
      ) as Parameters<typeof gmbService.updateAutomationSettings>[1],
    );

    return sendSuccess(res, settings, "GMB settings updated");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Update GMB settings error:", error);
    return sendError(res, "Failed to update GMB settings", 500, error);
  }
}

export async function disconnectGMB(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = DISCONNECT_GMB.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const result = await gmbService.disconnect(businessId);
    await invalidateTenantCache(userId, businessId);

    return sendSuccess(
      res,
      result,
      "Google My Business disconnected successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Disconnect GMB error:", error);
    return sendError(res, "Failed to disconnect GMB", 500, error);
  }
}

export async function getGMBPostsFromDB(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const posts = await gmbService.getCachedPosts(businessId);
    return sendSuccess(res, posts, "GMB posts retrieved from database");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB posts from DB error:", error);
    return sendError(res, "Failed to get GMB posts", 500, error);
  }
}

export async function getGMBReviewsFromDB(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const reviews = await gmbService.getCachedReviews(businessId);
    return sendSuccess(res, reviews, "GMB reviews retrieved from database");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get GMB reviews from DB error:", error);
    return sendError(res, "Failed to get GMB reviews", 500, error);
  }
}

export async function getAISuggestions(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_AI_SUGGESTIONS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const suggestions = await gmbAIService.generateSuggestions(
      businessId,
      payload.forceRefresh
    );
    return sendSuccess(res, suggestions, "AI suggestions generated successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get AI suggestions error:", error);
    return sendError(res, "Failed to generate AI suggestions", 500, error);
  }
}

export async function generateReviewResponse(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GENERATE_REVIEW_RESPONSE.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { businessName: true, businessType: true },
    });

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const result = await gmbAIService.generateReviewResponse(
      {
        reviewerName: payload.reviewerName,
        rating: payload.rating,
        comment: payload.comment,
        businessName: business.businessName,
        businessType: payload.businessType || business.businessType || undefined,
        reviewId: payload.reviewId,
      },
      payload.forceRefresh
    );

    return sendSuccess(res, result, "Review response generated successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Generate review response error:", error);
    return sendError(res, "Failed to generate review response", 500, error);
  }
}

export async function getPostSuggestions(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_POST_SUGGESTIONS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const suggestions = await gmbAIService.generatePostSuggestionsFromBlogs(
      businessId,
      payload.forceRefresh,
      payload.generateImages
    );

    return sendSuccess(
      res,
      suggestions,
      "Post suggestions generated successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    if (error instanceof GMBPostSuggestionSetupError) {
      return sendError(res, error.message, error.statusCode, error);
    }

    console.error("Get post suggestions error:", error);
    return sendError(res, "Failed to generate post suggestions", 500, error);
  }
}

export async function schedulePostSuggestion(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = SCHEDULE_POST_SUGGESTION.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const result = await gmbAIService.schedulePostSuggestion(
      payload.suggestionId,
      new Date(payload.scheduledAt)
    );

    if (!result.success) {
      return sendError(res, result.message, 400);
    }

    return sendSuccess(res, result, "Post scheduled successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Schedule post suggestion error:", error);
    return sendError(res, "Failed to schedule post", 500, error);
  }
}

export async function dismissPostSuggestion(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = DISMISS_POST_SUGGESTION.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const result = await gmbAIService.dismissPostSuggestion(payload.suggestionId);

    if (!result.success) {
      return sendError(res, result.message, 400);
    }

    return sendSuccess(res, result, "Post suggestion dismissed");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Dismiss post suggestion error:", error);
    return sendError(res, "Failed to dismiss post suggestion", 500, error);
  }
}

export async function publishPostSuggestion(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = PUBLISH_POST_SUGGESTION.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const suggestion = await prisma.gMBPostSuggestion.findUnique({
      where: { id: payload.suggestionId },
    });

    if (!suggestion) {
      return sendError(res, "Suggestion not found", 404);
    }

    if (suggestion.businessId !== businessId) {
      return sendError(res, "Unauthorized", 403);
    }

    let mediaUrls = (suggestion.mediaUrls as string[]) || [];

    if (mediaUrls.length === 0) {
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { businessName: true, businessType: true },
      });

      if (business) {
        const { imageGenerationService } = await import(
          "../services/image-generation.service"
        );
        const imageResult = await imageGenerationService.generateGMBPostImage(
          business.businessName,
          suggestion.title || suggestion.summary.substring(0, 50),
          suggestion.postType,
          business.businessType || undefined,
          suggestion.summary || undefined
        );

        if (imageResult.success && imageResult.imageUrl) {
          mediaUrls = [imageResult.imageUrl];
          console.log(
            `[GMB Publish] Auto-generated image for suggestion ${suggestion.id}: ${imageResult.imageUrl}`
          );

          await prisma.gMBPostSuggestion.update({
            where: { id: suggestion.id },
            data: { mediaUrls },
          });
        } else {
          console.warn(
            `[GMB Publish] Failed to auto-generate image: ${imageResult.error}`
          );
        }
      }
    }

    const post = await gmbService.createPost(businessId, {
      postType: suggestion.postType as "UPDATE" | "EVENT" | "OFFER" | "PRODUCT",
      summary: suggestion.summary,
      callToAction: suggestion.callToAction || undefined,
      mediaUrls,
      title: suggestion.title || undefined,
    });

    await prisma.gMBPostSuggestion.update({
      where: { id: payload.suggestionId },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        gmbPostId: post.id || null,
      },
    });

    return sendSuccess(res, post, "Post published successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Publish post suggestion error:", error);
    return sendError(res, "Failed to publish post", 500, error);
  }
}

export async function getReviewAnalysis(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_REVIEW_ANALYSIS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const analysis = await gmbAIService.generateReviewAnalysis(
      businessId,
      payload.forceRefresh
    );

    return sendSuccess(res, analysis, "Review analysis generated successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get review analysis error:", error);
    return sendError(res, "Failed to generate review analysis", 500, error);
  }
}

export async function syncAndAutoReplyReviews(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = SYNC_GMB.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const result = await gmbService.syncAndAutoReplyReviews(businessId);

    const message = result.autoReplyDisabled
      ? `Synced ${result.syncedCount} reviews. Auto-reply is disabled for this business.`
      : result.autoReplyResults
        ? `Synced ${result.syncedCount} reviews. Auto-replied to ${result.autoReplyResults.repliedCount} new reviews.`
        : `Synced ${result.syncedCount} reviews. No new reviews to reply to.`;

    return sendSuccess(res, result, message);
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Sync and auto-reply reviews error:", error);
    return sendError(res, "Failed to sync and auto-reply reviews", 500, error);
  }
}

export async function getReviewsWithAIReplies(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true },
    });

    if (!gmb) {
      return sendError(res, "Google My Business not connected", 404);
    }

    const reviews = await prisma.gMBReview.findMany({
      where: {
        gmbId: gmb.id,
        reviewDate: { gte: getGmbReviewWindowStart() },
      },
      include: {
        aiResponse: {
          select: {
            response: true,
            intent: true,
            generatedAt: true,
            expiresAt: true,
          },
        },
      },
      orderBy: { reviewDate: "desc" },
    });

    type ReviewWithAIReply = {
      id: string;
      reviewId: string;
      reviewerName: string;
      reviewerPhoto: string | null;
      rating: number;
      comment: string | null;
      reviewDate: string;
      response: string | null;
      responseDate: string | null;
      isResponded: boolean;
      aiReply: {
        response: string;
        intent: string | null;
        generatedAt: string;
        expiresAt: string;
        status: "pending" | "posted" | "expired";
      } | null;
    };

    const reviewsWithAI: ReviewWithAIReply[] = reviews.map((review) => {
      const now = new Date();
      let aiReplyStatus: "pending" | "posted" | "expired" = "pending";

      if (review.isResponded) {
        aiReplyStatus = "posted";
      } else if (review.aiResponse && new Date(review.aiResponse.expiresAt) < now) {
        aiReplyStatus = "expired";
      }

      return {
        id: review.id,
        reviewId: review.reviewId,
        reviewerName: review.reviewerName,
        reviewerPhoto: review.reviewerPhoto,
        rating: review.rating,
        comment: review.comment,
        reviewDate: review.reviewDate.toISOString(),
        response: review.response,
        responseDate: review.responseDate?.toISOString() || null,
        isResponded: review.isResponded,
        aiReply: review.aiResponse
          ? {
              response: review.aiResponse.response,
              intent: review.aiResponse.intent,
              generatedAt: review.aiResponse.generatedAt.toISOString(),
              expiresAt: review.aiResponse.expiresAt.toISOString(),
              status: aiReplyStatus,
            }
          : null,
      };
    });

    return sendSuccess(
      res,
      { reviews: reviewsWithAI },
      "Reviews with AI replies retrieved successfully"
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Get reviews with AI replies error:", error);
    return sendError(res, "Failed to get reviews with AI replies", 500, error);
  }
}

export async function generateAllPendingAIReplies(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const businessId = await getAuthorizedBusinessId(
      userId,
      payload.businessId,
      res
    );
    if (!businessId) {
      return;
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { businessName: true, businessType: true },
    });

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: { id: true },
    });

    if (!gmb) {
      return sendError(res, "Google My Business not connected", 404);
    }

    const reviewsWithoutAI = await prisma.gMBReview.findMany({
      where: {
        gmbId: gmb.id,
        reviewDate: { gte: getGmbReviewWindowStart() },
        isResponded: false,
        aiResponse: null,
      },
      select: {
        id: true,
        reviewId: true,
        reviewerName: true,
        rating: true,
        comment: true,
      },
    });

    type GenerationResult = {
      reviewId: string;
      success: boolean;
      intent?: string | null;
      error?: string;
    };

    const results: GenerationResult[] = [];

    for (const review of reviewsWithoutAI) {
      try {
        const aiResult = await gmbAIService.generateReviewResponse({
          reviewerName: review.reviewerName,
          rating: review.rating,
          comment: review.comment,
          businessName: business.businessName,
          businessType: business.businessType || undefined,
          reviewId: review.reviewId,
        });

        results.push({
          reviewId: review.reviewId,
          success: true,
          intent: aiResult.intent,
        });
      } catch (error) {
        results.push({
          reviewId: review.reviewId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    return sendSuccess(
      res,
      {
        total: reviewsWithoutAI.length,
        generated: successCount,
        failed: failedCount,
        results,
      },
      `Generated AI replies for ${successCount} reviews`
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    console.error("Generate all pending AI replies error:", error);
    return sendError(res, "Failed to generate AI replies", 500, error);
  }
}

export async function getGMBProfileHealth(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_PROFILE_HEALTH.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getProfileHealth(
      businessId,
      payload.forceRefresh,
    );
    return sendSuccess(res, result, "GMB profile health retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB profile health error:", error);
    return sendError(res, "Failed to get GMB profile health", 500, error);
  }
}

export async function getGMBDiscoveryKeywords(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_DISCOVERY_KEYWORDS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getDiscoveryKeywords(businessId, {
      forceRefresh: payload.forceRefresh,
      months: payload.months,
    });
    return sendSuccess(res, result, "GMB discovery keywords retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB discovery keywords error:", error);
    return sendError(res, "Failed to get GMB discovery keywords", 500, error);
  }
}

export async function getGMBMetricsTimeSeries(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_METRICS_TIMESERIES.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getMetricsTimeSeries(businessId, {
      forceRefresh: payload.forceRefresh,
      days: payload.days,
    });
    return sendSuccess(res, result, "GMB metrics time series retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB metrics time series error:", error);
    return sendError(res, "Failed to get GMB metrics time series", 500, error);
  }
}

export async function getGMBActions(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GMB_ACTIONS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getActions(
      businessId,
      payload.status,
    );
    return sendSuccess(res, result, "GMB actions retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB actions error:", error);
    return sendError(res, "Failed to get GMB actions", 500, error);
  }
}

export async function approveGMBAction(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_ACTION_MUTATION.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.approveAction(
      businessId,
      payload.actionId,
    );
    return sendSuccess(res, result, "GMB action approved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Approve GMB action error:", error);
    return sendError(res, "Failed to approve GMB action", 500, error);
  }
}

export async function dismissGMBAction(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_ACTION_MUTATION.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.dismissAction(
      businessId,
      payload.actionId,
    );
    return sendSuccess(res, result, "GMB action dismissed");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Dismiss GMB action error:", error);
    return sendError(res, "Failed to dismiss GMB action", 500, error);
  }
}

export async function getOrQueueGMBMedia(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_MEDIA.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = payload.sourceUrl
      ? await gmbLocalVisibilityService.queueMediaAsset(businessId, {
          sourceUrl: payload.sourceUrl,
          category: payload.category,
          caption: payload.caption,
        })
      : await gmbLocalVisibilityService.getMedia(businessId);

    return sendSuccess(res, result, "GMB media retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get or queue GMB media error:", error);
    return sendError(res, "Failed to get GMB media", 500, error);
  }
}

export async function getOrRunGMBRankScans(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_RANK_SCANS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = payload.runScan
      ? await gmbLocalVisibilityService.runRankScan(businessId, {
          keywords: payload.keywords,
          locationCode: payload.locationCode,
          latitude: payload.latitude,
          longitude: payload.longitude,
        })
      : await gmbLocalVisibilityService.getRankScans(businessId);

    return sendSuccess(res, result, "GMB rank scans retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof GMBRankScanThrottledError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      return sendError(res, error.message, 429, {
        reason: error.reason,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    console.error("Get or run GMB rank scans error:", error);
    return sendError(res, "Failed to get GMB rank scans", 500, error);
  }
}

export async function getOrRunGMBLocalPackScans(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_RANK_SCANS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = payload.runScan
      ? await gmbLocalVisibilityService.runLocalPackScan(businessId, {
          keywords: payload.keywords,
          locationCode: payload.locationCode,
          latitude: payload.latitude,
          longitude: payload.longitude,
        })
      : await gmbLocalVisibilityService.getLocalPackScans(businessId);

    return sendSuccess(res, result, "GMB local pack scans retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    if (error instanceof GMBRankScanThrottledError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      return sendError(res, error.message, 429, {
        reason: error.reason,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    console.error("Get or run GMB local pack scans error:", error);
    return sendError(res, "Failed to get GMB local pack scans", 500, error);
  }
}

export async function getGMBCompetitors(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getCompetitors(businessId);
    return sendSuccess(res, result, "GMB competitors retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB competitors error:", error);
    return sendError(res, "Failed to get GMB competitors", 500, error);
  }
}

export async function getGMBAttribution(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getAttribution(businessId);
    return sendSuccess(res, result, "GMB attribution retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB attribution error:", error);
    return sendError(res, "Failed to get GMB attribution", 500, error);
  }
}

export async function getGMBGoogleUpdates(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getGoogleUpdates(businessId);
    return sendSuccess(res, result, "GMB Google updates retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB Google updates error:", error);
    return sendError(res, "Failed to get GMB Google updates", 500, error);
  }
}

export async function getGMBAlerts(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getAlerts(businessId);
    return sendSuccess(res, result, "GMB alerts retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB alerts error:", error);
    return sendError(res, "Failed to get GMB alerts", 500, error);
  }
}

export async function getGMBReviewCampaigns(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_REVIEW_CAMPAIGNS.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const result = await gmbLocalVisibilityService.getReviewCampaigns(businessId);
    return sendSuccess(res, result, "GMB review campaigns retrieved");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Get GMB review campaigns error:", error);
    return sendError(res, "Failed to get GMB review campaigns", 500, error);
  }
}

export async function importGMBReviewContacts(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_REVIEW_CAMPAIGN_IMPORT.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const campaign = await prisma.gMBReviewCampaign.findFirst({
      where: { id: payload.campaignId, businessId },
      select: { id: true },
    });
    if (!campaign) {
      return sendError(res, "Campaign not found for this business", 404);
    }

    const { importReviewContacts } = await import(
      "../services/gmb-review-campaign.service"
    );
    const result = await importReviewContacts({
      campaignId: campaign.id,
      contacts: payload.contacts.map((c) => ({
        email: c.email,
        name: c.name,
        source: "api",
      })),
    });
    return sendSuccess(res, result, "Contacts imported");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Import GMB review contacts error:", error);
    return sendError(res, "Failed to import contacts", 500, error);
  }
}

export async function activateGMBReviewCampaign(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GMB_REVIEW_CAMPAIGN_ACTIVATE.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const campaign = await prisma.gMBReviewCampaign.findFirst({
      where: { id: payload.campaignId, businessId },
      select: { id: true },
    });
    if (!campaign) {
      return sendError(res, "Campaign not found for this business", 404);
    }

    const { activateCampaign, pauseCampaign } = await import(
      "../services/gmb-review-campaign.service"
    );
    if (payload.action === "activate") {
      await activateCampaign(campaign.id);
    } else {
      await pauseCampaign(campaign.id);
    }
    return sendSuccess(res, { campaignId: campaign.id, action: payload.action }, "Campaign updated");
  } catch (error) {
    if (error instanceof ZodError) return handleValidationError(res, error);
    console.error("Update GMB review campaign error:", error);
    return sendError(res, "Failed to update campaign", 500, error);
  }
}

// Public — must NOT be behind requireBackendAuth. Token is the credential.
export async function unsubscribeReviewContact(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const token = req.params?.token ?? req.body?.token;
    if (typeof token !== "string" || token.length < 16) {
      return res.status(400).send("Invalid unsubscribe link");
    }
    const { optOutByToken } = await import(
      "../services/gmb-review-campaign.service"
    );
    const ok = await optOutByToken(token);
    if (!ok) {
      return res.status(404).send("Unsubscribe link not found");
    }
    return res
      .status(200)
      .send(
        "You're unsubscribed. We won't email you again about reviews. You can close this tab.",
      );
  } catch (error) {
    console.error("Unsubscribe review contact error:", error);
    return res.status(500).send("Unsubscribe failed — please reply with STOP to opt out.");
  }
}

export async function getGMBPortfolio(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const result = await gmbLocalVisibilityService.getPortfolio(userId);
    return sendSuccess(res, result, "GMB portfolio retrieved");
  } catch (error) {
    console.error("Get GMB portfolio error:", error);
    return sendError(res, "Failed to get GMB portfolio", 500, error);
  }
}

export async function getEditImpacts(req: AuthenticatedRequest, res: Response) {
  try {
    const payload = GMB_BUSINESS_SCOPED.parse(req.body);
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) return;

    const businessId = await getAuthorizedBusinessId(userId, payload.businessId, res);
    if (!businessId) return;

    const { listEditImpactsForBusiness } = await import(
      "../services/gmb-edit-impact.service"
    );
    const impacts = await listEditImpactsForBusiness(businessId);
    return sendSuccess(res, { impacts }, "GMB edit impacts retrieved");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    console.error("Get GMB edit impacts error:", error);
    return sendError(res, "Failed to get GMB edit impacts", 500, error);
  }
}
