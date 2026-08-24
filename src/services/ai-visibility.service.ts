import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  getStats,
  getCitations,
  getTrend,
  triggerScan,
  getScores,
  triggerContentScoring,
  getRoutes,
  overrideRoute,
  assignRoutes,
  getOpportunities,
  addOpportunity,
  getDiscoveredQueriesHandler,
  triggerDiscovery,
  getTrialRunStatus,
  triggerTrialRun,
  getJobStatus,
  getShareOfVoiceHandler,
  getShareOfVoiceTrendHandler,
  generateTopQueries,
  getContentGaps,
  closeContentGap,
  connectGa4Handler,
  ga4StatusHandler,
  aiReferralStatsHandler,
  triggerGa4Sync,
  connectSearchConsoleHandler,
  searchConsoleStatusHandler,
  searchConsoleSitesHandler,
  selectSearchConsoleSiteHandler,
  searchConsoleSummaryHandler,
  triggerSearchConsoleSync,
  startSearchConsoleOAuthHandler,
  completeSearchConsoleOAuthHandler,
} from "../controllers/ai-visibility.controller";

const AiVisibilityRouter: Router = Router();

AiVisibilityRouter.use(requireBackendAuth);

// Dashboard stats
AiVisibilityRouter.post("/stats", getStats);
AiVisibilityRouter.post("/jobs/status", getJobStatus);

// Citation tracker
AiVisibilityRouter.post("/citations", getCitations);
AiVisibilityRouter.post("/citation-trend", getTrend);
AiVisibilityRouter.post("/trigger-scan", triggerScan);

// Share of Voice (Phase 1)
AiVisibilityRouter.post("/share-of-voice", getShareOfVoiceHandler);
AiVisibilityRouter.post("/share-of-voice-trend", getShareOfVoiceTrendHandler);

// Content scorecard
AiVisibilityRouter.post("/content-scores", getScores);
AiVisibilityRouter.post("/trigger-score", triggerContentScoring);

// Content routing
AiVisibilityRouter.post("/content-routes", getRoutes);
AiVisibilityRouter.post("/override-route", overrideRoute);
AiVisibilityRouter.post("/assign-routes", assignRoutes);

// AI keyword opportunities
AiVisibilityRouter.post("/opportunities", getOpportunities);
AiVisibilityRouter.post("/add-opportunity", addOpportunity);

// LLM Query Discovery
AiVisibilityRouter.post("/discovered-queries", getDiscoveredQueriesHandler);
AiVisibilityRouter.post("/trigger-discovery", triggerDiscovery);
AiVisibilityRouter.post("/generate-top-queries", generateTopQueries);

// Trial one-time AI Visibility run
AiVisibilityRouter.post("/trial-run/status", getTrialRunStatus);
AiVisibilityRouter.post("/trial-run/trigger", triggerTrialRun);

// Competitive Content Gap Analyzer (Phase 3)
AiVisibilityRouter.post("/content-gaps", getContentGaps);
AiVisibilityRouter.post("/close-gap", closeContentGap);

// GA4 AI-referral integration (Phase 4)
AiVisibilityRouter.post("/ga4-connect", connectGa4Handler);
AiVisibilityRouter.post("/ga4-status", ga4StatusHandler);
AiVisibilityRouter.post("/ga4-sync", triggerGa4Sync);
AiVisibilityRouter.post("/ai-referral-stats", aiReferralStatsHandler);

// Google Search Console integration
AiVisibilityRouter.post("/gsc-oauth/start", startSearchConsoleOAuthHandler);
AiVisibilityRouter.post("/gsc-oauth/callback", completeSearchConsoleOAuthHandler);
AiVisibilityRouter.post("/gsc-connect", connectSearchConsoleHandler);
AiVisibilityRouter.post("/gsc-status", searchConsoleStatusHandler);
AiVisibilityRouter.post("/gsc-sites", searchConsoleSitesHandler);
AiVisibilityRouter.post("/gsc-select-site", selectSearchConsoleSiteHandler);
AiVisibilityRouter.post("/gsc-sync", triggerSearchConsoleSync);
AiVisibilityRouter.post("/gsc-summary", searchConsoleSummaryHandler);

export default AiVisibilityRouter;
