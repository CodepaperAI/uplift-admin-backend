import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { sendError, sendSuccess } from "../utils/response.utils";
import { TrialAnalyticsService } from "../services/trial-analytics.service";

export async function getTrialAnalytics(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;

    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }
    if (req.params.userId !== userId) {
      return sendError(res, "Forbidden", 403);
    }

    const analytics = await TrialAnalyticsService.getTrialAnalytics(userId);

    if (!analytics) {
      return sendError(res, "Analytics not found", 404);
    }

    return sendSuccess(res, { analytics }, "Analytics retrieved successfully");
  } catch (error) {
    console.error("❌ Error getting trial analytics:", error);
    return sendError(res, "Failed to get trial analytics", 500, error);
  }
}

export async function getAllTrialAnalytics(req: Request, res: Response) {
  try {
    const analytics = await TrialAnalyticsService.getAllTrialAnalytics();
    return sendSuccess(res, { analytics }, "All analytics retrieved successfully");
  } catch (error) {
    console.error("❌ Error getting all trial analytics:", error);
    return sendError(res, "Failed to get all trial analytics", 500, error);
  }
}

export async function getConversionMetrics(req: Request, res: Response) {
  try {
    const metrics = await TrialAnalyticsService.getConversionMetrics();

    if (!metrics) {
      return sendError(res, "Failed to calculate metrics", 500);
    }

    return sendSuccess(res, { metrics }, "Conversion metrics retrieved successfully");
  } catch (error) {
    console.error("❌ Error getting conversion metrics:", error);
    return sendError(res, "Failed to get conversion metrics", 500, error);
  }
}

export async function getABTestResults(req: Request, res: Response) {
  try {
    const { testGroup } = req.params;

    if (!testGroup) {
      return sendError(res, "Test group is required", 400);
    }

    const results = await TrialAnalyticsService.getABTestResults(testGroup);
    return sendSuccess(res, { results }, "A/B test results retrieved successfully");
  } catch (error) {
    console.error("❌ Error getting A/B test results:", error);
    return sendError(res, "Failed to get A/B test results", 500, error);
  }
}

export async function trackUpgradeCTA(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;

    if (!userId) {
      return sendError(res, "User ID is required", 400);
    }

    await TrialAnalyticsService.trackUpgradeCTAClicked(userId);
    return sendSuccess(res, {}, "Upgrade CTA tracked successfully");
  } catch (error) {
    console.error("❌ Error tracking upgrade CTA:", error);
    return sendError(res, "Failed to track upgrade CTA", 500, error);
  }
}

export async function trackPricingPage(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;

    if (!userId) {
      return sendError(res, "User ID is required", 400);
    }

    await TrialAnalyticsService.trackPricingPageVisited(userId);
    return sendSuccess(res, {}, "Pricing page visit tracked successfully");
  } catch (error) {
    console.error("❌ Error tracking pricing page:", error);
    return sendError(res, "Failed to track pricing page", 500, error);
  }
}

export async function trackCheckoutStarted(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;

    if (!userId) {
      return sendError(res, "User ID is required", 400);
    }

    await TrialAnalyticsService.trackCheckoutStarted(userId);
    return sendSuccess(res, {}, "Checkout started tracked successfully");
  } catch (error) {
    console.error("❌ Error tracking checkout started:", error);
    return sendError(res, "Failed to track checkout started", 500, error);
  }
}
