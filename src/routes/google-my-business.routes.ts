import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";
import {
  getGmbAttributeCatalog,
  getGmbAttributes,
  getGmbCategories,
  getGmbHours,
  getGmbSpecialHours,
  getGmbVerification,
  updateGmbAttributes,
  updateGmbCategories,
  updateGmbHours,
  updateGmbSpecialHours,
} from "../controllers/gmb-profile-editor.controller";
import {
  approveGMBAction,
  connectGMB,
  connectGMBDemo,
  createGMBPost,
  disconnectGMB,
  disconnectGMBDemo,
  dismissGMBAction,
  dismissPostSuggestion,
  generateAllPendingAIReplies,
  generateReviewResponse,
  getAISuggestions,
  getEditImpacts,
  getGMBAlerts,
  getGMBAttribution,
  getGMBCompetitors,
  getGMBAccounts,
  getGMBConnectionStatus,
  getGMBDiscoveryKeywords,
  getGMBGoogleUpdates,
  getGMBInsights,
  getGMBLocations,
  getGMBMetricsTimeSeries,
  getGMBPortfolio,
  getGMBPosts,
  getGMBPostsFromDB,
  getGMBProfileHealth,
  getGMBReviewCampaigns,
  importGMBReviewContacts,
  activateGMBReviewCampaign,
  unsubscribeReviewContact,
  getGMBReviews,
  getGMBReviewsFromDB,
  getGMBActions,
  getOrQueueGMBMedia,
  getOrRunGMBLocalPackScans,
  getOrRunGMBRankScans,
  getGMBSettings,
  startGmbOAuth,
  completeGmbOAuthCallback,
  getPostSuggestions,
  getReviewAnalysis,
  getReviewsWithAIReplies,
  publishPostSuggestion,
  resetGMBDemo,
  respondToGMBReview,
  schedulePostSuggestion,
  selectGMBLocation,
  syncAndAutoReplyReviews,
  syncGMB,
  updateGMBSettings,
  updateBusinessInfo,
} from "../controllers/google-my-business.controller";

const GoogleMyBusinessRouter: Router = Router();

// Public route — token is the credential. Must be declared BEFORE
// requireBackendAuth so the middleware doesn't reject the request.
GoogleMyBusinessRouter.get(
  "/review-campaigns/unsubscribe/:token",
  unsubscribeReviewContact,
);

GoogleMyBusinessRouter.use(requireBackendAuth);

const profileEditorWriteLimit = sensitiveRouteRateLimit({
  namespace: "gmb-profile-editor-write",
  limit: 60,
  windowSeconds: 60,
});

// These endpoints are the only source of truth for the structured GBP editor.
// Next.js routes authenticate the browser session and forward a short-lived,
// signed backend assertion; no frontend handler reads or writes Prisma.
GoogleMyBusinessRouter.get("/profile-editor/attributes/catalog", getGmbAttributeCatalog);
GoogleMyBusinessRouter.get("/profile-editor/attributes", getGmbAttributes);
GoogleMyBusinessRouter.put(
  "/profile-editor/attributes",
  profileEditorWriteLimit,
  updateGmbAttributes,
);
GoogleMyBusinessRouter.get("/profile-editor/categories", getGmbCategories);
GoogleMyBusinessRouter.put(
  "/profile-editor/categories",
  profileEditorWriteLimit,
  updateGmbCategories,
);
GoogleMyBusinessRouter.get("/profile-editor/hours", getGmbHours);
GoogleMyBusinessRouter.put(
  "/profile-editor/hours",
  profileEditorWriteLimit,
  updateGmbHours,
);
GoogleMyBusinessRouter.get("/profile-editor/special-hours", getGmbSpecialHours);
GoogleMyBusinessRouter.put(
  "/profile-editor/special-hours",
  profileEditorWriteLimit,
  updateGmbSpecialHours,
);
GoogleMyBusinessRouter.get("/profile-editor/verification", getGmbVerification);

GoogleMyBusinessRouter.post("/oauth/start", startGmbOAuth);
GoogleMyBusinessRouter.post("/oauth/callback", completeGmbOAuthCallback);
GoogleMyBusinessRouter.post("/connect", connectGMB);
GoogleMyBusinessRouter.post("/demo/connect", connectGMBDemo);
GoogleMyBusinessRouter.post("/demo/reset", resetGMBDemo);
GoogleMyBusinessRouter.post("/demo/disconnect", disconnectGMBDemo);
GoogleMyBusinessRouter.post("/select-location", selectGMBLocation);
GoogleMyBusinessRouter.post("/disconnect", disconnectGMB);
GoogleMyBusinessRouter.post("/status", getGMBConnectionStatus);
GoogleMyBusinessRouter.post("/sync", syncGMB);
GoogleMyBusinessRouter.post("/settings", getGMBSettings);
GoogleMyBusinessRouter.post("/settings/update", updateGMBSettings);
GoogleMyBusinessRouter.post("/profile-health", getGMBProfileHealth);
GoogleMyBusinessRouter.post("/discovery-keywords", getGMBDiscoveryKeywords);
GoogleMyBusinessRouter.post("/metrics/timeseries", getGMBMetricsTimeSeries);
GoogleMyBusinessRouter.post("/actions", getGMBActions);
GoogleMyBusinessRouter.post("/actions/approve", approveGMBAction);
GoogleMyBusinessRouter.post("/actions/dismiss", dismissGMBAction);
GoogleMyBusinessRouter.post("/media", getOrQueueGMBMedia);
GoogleMyBusinessRouter.post("/rank-scans", getOrRunGMBRankScans);
GoogleMyBusinessRouter.post("/local-pack-scans", getOrRunGMBLocalPackScans);
GoogleMyBusinessRouter.post("/competitors", getGMBCompetitors);
GoogleMyBusinessRouter.post("/attribution", getGMBAttribution);
GoogleMyBusinessRouter.post("/google-updates", getGMBGoogleUpdates);
GoogleMyBusinessRouter.post("/alerts", getGMBAlerts);
GoogleMyBusinessRouter.post("/review-campaigns", getGMBReviewCampaigns);
GoogleMyBusinessRouter.post("/review-campaigns/import", importGMBReviewContacts);
GoogleMyBusinessRouter.post("/review-campaigns/activate", activateGMBReviewCampaign);
GoogleMyBusinessRouter.post("/portfolio", getGMBPortfolio);

GoogleMyBusinessRouter.post("/accounts", getGMBAccounts);
GoogleMyBusinessRouter.post("/locations", getGMBLocations);

GoogleMyBusinessRouter.post("/posts/create", createGMBPost);
GoogleMyBusinessRouter.post("/posts", getGMBPosts);
GoogleMyBusinessRouter.post("/posts/db", getGMBPostsFromDB);

GoogleMyBusinessRouter.post("/reviews", getGMBReviews);
GoogleMyBusinessRouter.post("/reviews/db", getGMBReviewsFromDB);
GoogleMyBusinessRouter.post("/reviews/respond", respondToGMBReview);
GoogleMyBusinessRouter.post("/reviews/sync-and-auto-reply", syncAndAutoReplyReviews);
GoogleMyBusinessRouter.post("/reviews/with-ai-replies", getReviewsWithAIReplies);
GoogleMyBusinessRouter.post("/reviews/generate-all-ai-replies", generateAllPendingAIReplies);

GoogleMyBusinessRouter.post("/insights", getGMBInsights);
GoogleMyBusinessRouter.post("/business/update", updateBusinessInfo);

GoogleMyBusinessRouter.post("/ai/suggestions", getAISuggestions);
GoogleMyBusinessRouter.post("/ai/review-response", generateReviewResponse);
GoogleMyBusinessRouter.post("/ai/post-suggestions", getPostSuggestions);
GoogleMyBusinessRouter.post("/ai/review-analysis", getReviewAnalysis);

GoogleMyBusinessRouter.post("/posts/schedule", schedulePostSuggestion);
GoogleMyBusinessRouter.post("/posts/publish-suggestion", publishPostSuggestion);
GoogleMyBusinessRouter.post("/posts/dismiss", dismissPostSuggestion);

GoogleMyBusinessRouter.post("/edit-impacts", getEditImpacts);

export default GoogleMyBusinessRouter;
