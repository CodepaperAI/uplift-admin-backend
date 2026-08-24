import type { Response } from "express";
import { z, ZodError } from "zod";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import { sendSuccess, sendError } from "../utils/response.utils";
import {
  AiVisibilityAccessError,
  assertAiVisibilityAccess,
  assertPaidAiVisibilityAccess,
} from "../utils/ai-visibility-access.utils";
import { getOwnedActiveBusiness } from "../utils/business-owner-access.utils";
import { isPlatformStaffSubscriptionBypassRole } from "../utils/platform-role.utils";
import {
  getAiVisibilityStats,
  getCitationTracker,
  getCitationTrend,
} from "../services/ai-citation-monitoring.service";
import {
  getShareOfVoice,
  getShareOfVoiceTrend,
  type SovWindow,
} from "../services/share-of-voice.service";
import { getContentScores } from "../services/content-scorecard.service";
import { getContentRoutes, overrideContentRoute, assignRoutesForBusiness } from "../services/content-routing.service";
import { discoverAiKeywordOpportunities, addOpportunityKeywordToPlan } from "../services/ai-keyword-opportunity.service";
import {
  getDiscoveredQueries,
  generateTopDiscoveredQueries,
} from "../services/llm-query-discovery.service";
import {
  getCompetitiveGaps,
  markGapResolved,
} from "../services/competitive-gap.service";
import {
  connectGa4,
  getGa4Status,
  getAiReferralStats,
} from "../services/ga4-analytics.service";
import {
  connectSearchConsole,
  getSearchConsoleStatus,
  getSearchConsoleSummary,
  listSearchConsoleSites,
  selectSearchConsoleSite,
} from "../services/search-console.service";
import {
  createOrReuseAiVisibilityJob,
  getLatestAiVisibilityJobs,
  markAiVisibilityJobFinished,
  type AiVisibilityJobSource,
} from "../services/ai-visibility-job.service";
import {
  AiVisibilityTrialRunError,
  createTrialAiVisibilityRun,
  getAiVisibilityRunPolicyStatus,
} from "../services/ai-visibility-run-policy.service";
import { ContentRouteType } from "@prisma/client";
import {
  isGoogleOAuthStateConfigured,
  signGoogleOAuthState,
  verifyGoogleOAuthState,
} from "../utils/google-oauth-state";

const GOOGLE_OAUTH_START = z.object({
  businessId: z.string().min(1).max(128),
  redirectUri: z.string().url().max(2_048),
});
const GOOGLE_OAUTH_CALLBACK = z.object({
  code: z.string().min(1).max(4_096),
  state: z.string().min(1).max(4_096),
});

/**
 * Translate an AiVisibilityAccessError into the appropriate HTTP response.
 * Returns true if a response was sent (caller should stop).
 *
 *   business_not_found     → 404
 *   inactive_business      → 403
 *   subscription_required  → 402 (Payment Required)
 */
async function enforceAiVisibilityAccess(
  businessId: string,
  res: Response,
): Promise<boolean> {
  try {
    await assertAiVisibilityAccess(businessId);
    return false;
  } catch (err) {
    if (err instanceof AiVisibilityAccessError) {
      const status =
        err.reason === "business_not_found"
          ? 404
          : err.reason === "inactive_business"
            ? 403
            : 402;
      sendError(res, err.message, status);
      return true;
    }
    throw err;
  }
}

async function enforceBusinessOwnerAccess(
  req: AuthenticatedRequest,
  businessId: string,
  res: Response,
): Promise<boolean> {
  const userId = req.authUserId;
  if (!userId) {
    sendError(res, "Unauthorized", 401);
    return true;
  }

  const business = await getOwnedActiveBusiness({ businessId, userId });

  if (!business) {
    sendError(res, "Business not found or access denied", 404);
    return true;
  }

  return false;
}

async function getRequesterManualSource(
  userId?: string | null,
): Promise<{ source: AiVisibilityJobSource; isPlatformStaff: boolean }> {
  if (!userId) {
    return { source: "manual", isPlatformStaff: false };
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const isPlatformStaff = Boolean(
    user?.role && isPlatformStaffSubscriptionBypassRole(user.role),
  );
  return {
    source: isPlatformStaff ? "manual_admin" : "manual",
    isPlatformStaff,
  };
}

async function enforcePaidAiVisibilityAccess(
  businessId: string,
  res: Response,
  isPlatformStaff: boolean,
): Promise<boolean> {
  if (isPlatformStaff) return false;

  try {
    await assertPaidAiVisibilityAccess(businessId);
    return false;
  } catch (err) {
    if (err instanceof AiVisibilityAccessError) {
      const status =
        err.reason === "business_not_found"
          ? 404
          : err.reason === "inactive_business"
            ? 403
            : 402;
      sendError(res, err.message, status);
      return true;
    }
    throw err;
  }
}

/**
 * GET /api/v1/ai-visibility/stats
 */
export async function getStats(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const stats = await getAiVisibilityStats(businessId);
    return sendSuccess(res, stats);
  } catch (error: any) {
    console.error("❌ AI Visibility stats error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/citations
 */
export async function getCitations(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const citations = await getCitationTracker(businessId);
    return sendSuccess(res, citations);
  } catch (error: any) {
    console.error("❌ AI Visibility citations error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/citation-trend
 */
export async function getTrend(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId, keyword, days } = req.body;
    if (!businessId || !keyword) return sendError(res, "businessId and keyword are required", 400);

    const trend = await getCitationTrend(businessId, keyword, days || 30);
    return sendSuccess(res, trend);
  } catch (error: any) {
    console.error("❌ AI Visibility trend error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/share-of-voice
 */
export async function getShareOfVoiceHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, window } = req.body as {
      businessId?: string;
      window?: SovWindow;
    };
    if (!businessId) return sendError(res, "businessId is required", 400);

    const sov = await getShareOfVoice(businessId, { window });
    return sendSuccess(res, sov);
  } catch (error: any) {
    console.error("❌ AI Visibility share-of-voice error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/share-of-voice-trend
 */
export async function getShareOfVoiceTrendHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, keyword, days } = req.body as {
      businessId?: string;
      keyword?: string;
      days?: number;
    };
    if (!businessId) return sendError(res, "businessId is required", 400);

    const trend = await getShareOfVoiceTrend(businessId, {
      keyword,
      days: typeof days === "number" ? days : undefined,
    });
    return sendSuccess(res, trend);
  } catch (error: any) {
    console.error("❌ AI Visibility share-of-voice-trend error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/trigger-scan
 */
export async function triggerScan(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    const { source, isPlatformStaff } = await getRequesterManualSource(
      req.authUserId,
    );
    if (await enforcePaidAiVisibilityAccess(businessId, res, isPlatformStaff)) {
      return;
    }

    const { job, reused } = await createOrReuseAiVisibilityJob({
      businessId,
      type: "citation_scan",
      requestedByUserId: req.authUserId,
      source,
    });

    if (!reused) {
      try {
        await inngest.send({
          name: "ai-visibility/scan",
          data: { businessId, jobId: job.id },
        });
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId: job.id,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    }

    return sendSuccess(
      res,
      { queued: !reused, reused, job },
      reused ? "Citation scan already running" : "Citation scan queued",
    );
  } catch (error: any) {
    console.error("❌ AI Visibility trigger scan error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/content-scores
 */
export async function getScores(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const scores = await getContentScores(businessId);
    return sendSuccess(res, scores);
  } catch (error: any) {
    console.error("❌ AI Visibility content scores error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/trigger-score
 */
export async function triggerContentScoring(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    const { source, isPlatformStaff } = await getRequesterManualSource(
      req.authUserId,
    );
    if (await enforcePaidAiVisibilityAccess(businessId, res, isPlatformStaff)) {
      return;
    }

    const { job, reused } = await createOrReuseAiVisibilityJob({
      businessId,
      type: "content_scoring",
      requestedByUserId: req.authUserId,
      source,
    });

    if (!reused) {
      try {
        await inngest.send({
          name: "ai-visibility/score-content",
          data: { businessId, jobId: job.id },
        });
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId: job.id,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    }

    return sendSuccess(
      res,
      { queued: !reused, reused, job },
      reused ? "Content scoring already running" : "Content scoring queued",
    );
  } catch (error: any) {
    console.error("❌ AI Visibility trigger score error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/content-routes
 */
export async function getRoutes(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const routes = await getContentRoutes(businessId);
    return sendSuccess(res, routes);
  } catch (error: any) {
    console.error("❌ AI Visibility content routes error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/override-route
 */
export async function overrideRoute(req: AuthenticatedRequest, res: Response) {
  try {
    const { blogId, route, reason } = req.body;
    if (!blogId || !route) return sendError(res, "blogId and route are required", 400);

    if (!["GOOGLE", "LLM", "DUAL"].includes(route)) {
      return sendError(res, "route must be GOOGLE, LLM, or DUAL", 400);
    }

    // overrideRoute operates per-blog; resolve the owning business and
    // enforce the same trial-or-paid gate as the other triggers.
    const blog = await prisma.blog.findUnique({
      where: { id: blogId },
      select: { businessId: true },
    });
    if (!blog) return sendError(res, "Blog not found", 404);
    if (await enforceAiVisibilityAccess(blog.businessId, res)) return;

    const result = await overrideContentRoute(blogId, route as ContentRouteType, reason);
    return sendSuccess(res, result);
  } catch (error: any) {
    console.error("❌ AI Visibility override route error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/assign-routes
 */
export async function assignRoutes(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    const results = await assignRoutesForBusiness(businessId);
    return sendSuccess(res, { assigned: results.length });
  } catch (error: any) {
    console.error("❌ AI Visibility assign routes error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/opportunities
 */
export async function getOpportunities(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const opportunities = await discoverAiKeywordOpportunities(businessId);
    return sendSuccess(res, opportunities);
  } catch (error: any) {
    console.error("❌ AI Visibility opportunities error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/add-opportunity
 */
export async function addOpportunity(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId, keyword } = req.body;
    const userId = req.authUserId;
    if (!businessId || !keyword) return sendError(res, "businessId and keyword are required", 400);
    if (!userId) return sendError(res, "Unauthorized", 401);
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    const result = await addOpportunityKeywordToPlan(businessId, userId, keyword);
    return sendSuccess(res, result);
  } catch (error: any) {
    console.error("❌ AI Visibility add opportunity error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/discovered-queries
 */
export async function getDiscoveredQueriesHandler(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const queries = await getDiscoveredQueries(businessId);
    return sendSuccess(res, queries);
  } catch (error: any) {
    console.error("❌ AI Visibility discovered queries error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/trigger-discovery
 */
export async function triggerDiscovery(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    const { source, isPlatformStaff } = await getRequesterManualSource(
      req.authUserId,
    );
    if (await enforcePaidAiVisibilityAccess(businessId, res, isPlatformStaff)) {
      return;
    }

    const { job, reused } = await createOrReuseAiVisibilityJob({
      businessId,
      type: "query_discovery",
      requestedByUserId: req.authUserId,
      source,
    });

    if (!reused) {
      try {
        await inngest.send({
          name: "ai-visibility/discover",
          data: { businessId, jobId: job.id },
        });
      } catch (error: any) {
        await markAiVisibilityJobFinished({
          jobId: job.id,
          status: "failed",
          lastError: error.message,
        });
        throw error;
      }
    }

    return sendSuccess(
      res,
      { queued: !reused, reused, job },
      reused ? "Query discovery already running" : "Query discovery queued",
    );
  } catch (error: any) {
    console.error("❌ AI Visibility trigger discovery error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/trial-run/status
 */
export async function getTrialRunStatus(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const status = await getAiVisibilityRunPolicyStatus(businessId);
    return sendSuccess(res, status);
  } catch (error: any) {
    console.error("❌ AI Visibility trial-run status error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/trial-run/trigger
 */
export async function triggerTrialRun(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);

    const { trialRun, citationJob, discoveryJob } =
      await createTrialAiVisibilityRun({
        businessId,
        requestedByUserId: req.authUserId,
      });

    try {
      await inngest.send({
        name: "ai-visibility/scan",
        data: {
          businessId,
          jobId: citationJob.id,
          source: "trial_once",
          periodKey: "trial",
        },
      });
      await inngest.send({
        name: "ai-visibility/discover",
        data: {
          businessId,
          jobId: discoveryJob.id,
          source: "trial_once",
          periodKey: "trial",
        },
      });
    } catch (error: any) {
      await Promise.allSettled([
        markAiVisibilityJobFinished({
          jobId: citationJob.id,
          status: "failed",
          lastError: error.message,
        }),
        markAiVisibilityJobFinished({
          jobId: discoveryJob.id,
          status: "failed",
          lastError: error.message,
        }),
        prisma.aiVisibilityTrialRun.update({
          where: { id: trialRun.id },
          data: { status: "failed" },
        }),
      ]);
      throw error;
    }

    return sendSuccess(
      res,
      {
        queued: true,
        trialRun,
        jobs: {
          citation_scan: citationJob,
          query_discovery: discoveryJob,
        },
      },
      "Trial AI Visibility run queued",
    );
  } catch (error: any) {
    if (error instanceof AiVisibilityTrialRunError) {
      const status =
        error.reason === "business_not_found"
          ? 404
          : error.reason === "inactive_business"
            ? 403
            : error.reason === "already_used"
              ? 409
              : 402;
      return sendError(res, error.message, status);
    }
    console.error("❌ AI Visibility trial-run trigger error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/ga4-connect
 *
 * Link a business to a GA4 property. Customer may also supply a per-business
 * service account JSON; when absent we fall back to the global service
 * account (which needs to be granted Viewer on their property).
 */
export async function connectGa4Handler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, ga4PropertyId, serviceAccountJson } = req.body as {
      businessId?: string;
      ga4PropertyId?: string;
      serviceAccountJson?: string;
    };
    if (!businessId || !ga4PropertyId)
      return sendError(
        res,
        "businessId and ga4PropertyId are required",
        400,
      );
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    // Trigger an initial sync after connecting so the dashboard isn't empty.
    await connectGa4(businessId, { ga4PropertyId, serviceAccountJson });
    try {
      await inngest.send({
        name: "ai-visibility/ga4-sync",
        data: { businessId, days: 35 },
      });
    } catch (err: any) {
      console.warn(
        "[ai-visibility] initial GA4 sync enqueue failed:",
        err?.message ?? err,
      );
    }
    const status = await getGa4Status(businessId);
    return sendSuccess(res, status, "GA4 connected");
  } catch (error: any) {
    console.error("❌ AI Visibility ga4-connect error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/ga4-status
 */
export async function ga4StatusHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId } = req.body as { businessId?: string };
    if (!businessId) return sendError(res, "businessId is required", 400);

    const status = await getGa4Status(businessId);
    return sendSuccess(res, status);
  } catch (error: any) {
    console.error("❌ AI Visibility ga4-status error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/ai-referral-stats
 */
export async function aiReferralStatsHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, days } = req.body as {
      businessId?: string;
      days?: number;
    };
    if (!businessId) return sendError(res, "businessId is required", 400);

    const stats = await getAiReferralStats(businessId, {
      days: typeof days === "number" ? days : undefined,
    });
    return sendSuccess(res, stats);
  } catch (error: any) {
    console.error("❌ AI Visibility ai-referral-stats error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/ga4-sync
 *
 * Manual "sync now" trigger. Fires an Inngest event so the client doesn't
 * block on the GA4 API call.
 */
export async function triggerGa4Sync(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, days } = req.body as {
      businessId?: string;
      days?: number;
    };
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    await inngest.send({
      name: "ai-visibility/ga4-sync",
      data: { businessId, days: typeof days === "number" ? days : 35 },
    });
    return sendSuccess(res, { queued: true });
  } catch (error: any) {
    console.error("❌ AI Visibility ga4-sync error:", error);
    return sendError(res, error.message, 500);
  }
}

async function enqueueInitialSearchConsoleSync(
  businessId: string,
  status: { siteUrl?: string | null },
) {
  if (!status.siteUrl) return;
  try {
    await inngest.send({
      name: "search-console/sync-business",
      data: { businessId, days: 35 },
    });
  } catch (error) {
    console.warn(
      "[search-console] initial sync enqueue failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function startSearchConsoleOAuthHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GOOGLE_OAUTH_START.parse(req.body);
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    if (await enforceBusinessOwnerAccess(req, payload.businessId, res)) return;
    if (await enforceAiVisibilityAccess(payload.businessId, res)) return;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId || !isGoogleOAuthStateConfigured()) {
      return sendError(res, "Connection is temporarily unavailable", 503);
    }
    const state = signGoogleOAuthState({
      provider: "gsc",
      userId,
      businessId: payload.businessId,
      redirectUri: payload.redirectUri,
    });
    if (!state) return sendError(res, "Connection request is invalid", 400);

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: payload.redirectUri,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return sendSuccess(res, { url: url.toString() }, "Connection ready");
  } catch (error) {
    if (error instanceof ZodError) {
      return sendError(res, "Connection request is invalid", 400);
    }
    return sendError(res, "Could not start connection", 500, error);
  }
}

export async function completeSearchConsoleOAuthHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const payload = GOOGLE_OAUTH_CALLBACK.parse(req.body);
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const state = verifyGoogleOAuthState(payload.state, "gsc");
    if (!state || state.userId !== userId) {
      return sendError(res, "Connection request is invalid", 403);
    }
    if (await enforceBusinessOwnerAccess(req, state.businessId, res)) return;
    if (await enforceAiVisibilityAccess(state.businessId, res)) return;

    const status = await connectSearchConsole(state.businessId, {
      code: payload.code,
      redirectUri: state.redirectUri,
    });
    await enqueueInitialSearchConsoleSync(state.businessId, status);
    return sendSuccess(
      res,
      { ...status, businessId: state.businessId },
      "Search Console connected",
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return sendError(res, "Connection request is invalid", 400);
    }
    return sendError(res, "Could not complete connection", 500, error);
  }
}

/**
 * POST /api/v1/ai-visibility/gsc-connect
 *
 * Legacy authenticated exchange endpoint. New dashboard clients use the
 * backend-owned /gsc-oauth/start and /gsc-oauth/callback state lifecycle.
 */
export async function connectSearchConsoleHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, code, redirectUri } = req.body as {
      businessId?: string;
      code?: string;
      redirectUri?: string;
    };
    if (!businessId || !code || !redirectUri) {
      return sendError(res, "businessId, code, and redirectUri are required", 400);
    }
    if (await enforceBusinessOwnerAccess(req, businessId, res)) return;
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    const status = await connectSearchConsole(businessId, {
      code,
      redirectUri,
    });

    await enqueueInitialSearchConsoleSync(businessId, status);

    return sendSuccess(res, status, "Search Console connected");
  } catch (error: any) {
    console.error("❌ AI Visibility gsc-connect error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/gsc-status
 */
export async function searchConsoleStatusHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId } = req.body as { businessId?: string };
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (await enforceBusinessOwnerAccess(req, businessId, res)) return;

    const status = await getSearchConsoleStatus(businessId);
    return sendSuccess(res, status);
  } catch (error: any) {
    console.error("❌ AI Visibility gsc-status error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/gsc-sites
 */
export async function searchConsoleSitesHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId } = req.body as { businessId?: string };
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (await enforceBusinessOwnerAccess(req, businessId, res)) return;

    const sites = await listSearchConsoleSites(businessId);
    return sendSuccess(res, sites);
  } catch (error: any) {
    console.error("❌ AI Visibility gsc-sites error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/gsc-select-site
 */
export async function selectSearchConsoleSiteHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, siteUrl } = req.body as {
      businessId?: string;
      siteUrl?: string;
    };
    if (!businessId || !siteUrl) {
      return sendError(res, "businessId and siteUrl are required", 400);
    }
    if (await enforceBusinessOwnerAccess(req, businessId, res)) return;
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    const status = await selectSearchConsoleSite(businessId, siteUrl);
    return sendSuccess(res, status, "Search Console property selected");
  } catch (error: any) {
    console.error("❌ AI Visibility gsc-select-site error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/gsc-summary
 */
export async function searchConsoleSummaryHandler(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, days } = req.body as {
      businessId?: string;
      days?: number;
    };
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (await enforceBusinessOwnerAccess(req, businessId, res)) return;

    const summary = await getSearchConsoleSummary(businessId, {
      days: typeof days === "number" ? days : undefined,
    });
    return sendSuccess(res, summary);
  } catch (error: any) {
    console.error("❌ AI Visibility gsc-summary error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/gsc-sync
 */
export async function triggerSearchConsoleSync(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, days } = req.body as {
      businessId?: string;
      days?: number;
    };
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (await enforceBusinessOwnerAccess(req, businessId, res)) return;
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    await inngest.send({
      name: "search-console/sync-business",
      data: { businessId, days: typeof days === "number" ? days : 35 },
    });
    return sendSuccess(res, { queued: true });
  } catch (error: any) {
    console.error("❌ AI Visibility gsc-sync error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/content-gaps
 */
export async function getContentGaps(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId } = req.body as { businessId?: string };
    if (!businessId) return sendError(res, "businessId is required", 400);

    const gaps = await getCompetitiveGaps(businessId);
    return sendSuccess(res, gaps);
  } catch (error: any) {
    console.error("❌ AI Visibility content-gaps error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/close-gap
 *
 * Marks a gap as resolved (either because the user generated fresh content
 * for it, or because they're dismissing it). Caller can optionally link
 * the resolving blog.
 */
export async function closeContentGap(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, gapId, blogId } = req.body as {
      businessId?: string;
      gapId?: string;
      blogId?: string;
    };
    if (!businessId || !gapId)
      return sendError(res, "businessId and gapId are required", 400);

    await markGapResolved(gapId, businessId, blogId);
    return sendSuccess(res, { ok: true });
  } catch (error: any) {
    console.error("❌ AI Visibility close-gap error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/generate-top-queries
 *
 * Add the top N un-targeted discovered queries to the content plan in one
 * shot. Reuses the single-keyword plan flow so the monthly AI keyword cap
 * and dedup logic still apply.
 */
export async function generateTopQueries(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const { businessId, limit } = req.body as {
      businessId?: string;
      limit?: number;
    };
    const userId = req.authUserId;
    if (!businessId) return sendError(res, "businessId is required", 400);
    if (!userId) return sendError(res, "Unauthorized", 401);
    if (await enforceAiVisibilityAccess(businessId, res)) return;

    const result = await generateTopDiscoveredQueries(businessId, userId, {
      limit: typeof limit === "number" ? limit : undefined,
    });
    return sendSuccess(res, result);
  } catch (error: any) {
    console.error("❌ AI Visibility generate-top-queries error:", error);
    return sendError(res, error.message, 500);
  }
}

/**
 * POST /api/v1/ai-visibility/jobs/status
 */
export async function getJobStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const { businessId } = req.body;
    if (!businessId) return sendError(res, "businessId is required", 400);

    const jobs = await getLatestAiVisibilityJobs(businessId);
    return sendSuccess(res, jobs);
  } catch (error: any) {
    console.error("❌ AI Visibility job status error:", error);
    return sendError(res, error.message, 500);
  }
}
