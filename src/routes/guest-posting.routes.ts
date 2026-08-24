import { Router } from "express";
import {
    checkEmailReply,
    checkIMAPStatus,
    checkPublishedPost,
    // Campaigns
    createCampaign,
    // Publishers
    createPublisher,
    // Submissions
    createSubmission,
    deleteCampaign,
    deletePublisher,
    deleteSubmission,
    enrichPublisherMetrics,
    // Email Automation
    generatePitchEmail,
    getCampaignAnalytics,
    getCampaignById,
    getCampaigns,
    getPublisherById,
    // Analytics
    getPublisherPerformance,
    getPublishers,
    getSubmissionById,
    getSubmissions,
    // Suggestions
    getSuggestedPublishers,
    handleEmailWebhook,
    markSuggestionsAsReviewed,
    sendPitchEmail,
    updateCampaign,
    updatePublisher,
    updateSubmission,
    updateSubmissionStatus,
} from "../controllers/guest-posting.controller";
import {
    analyzePublisherUrl,
    bulkCreatePublishers,
    discoverFromCompetitors,
    discoverFromMedium,
    discoverFromReddit,
    discoverPublishers,
} from "../controllers/publisher-discovery.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { requireResendWebhook } from "../middleware/require-resend-webhook";

const router = Router();

// Provider webhook remains public but must pass its cryptographic signature.
router.post("/email-webhook", requireResendWebhook, handleEmailWebhook);
router.use(requireBackendAuth, bindAuthenticatedUser);

// ============================================
// Publisher Routes
// ============================================
router.post("/publishers", createPublisher);
router.get("/publishers", getPublishers);
router.get("/publishers/:id", getPublisherById);
router.put("/publishers/:id", updatePublisher);
router.delete("/publishers/:id", deletePublisher);
router.post("/publishers/:id/enrich-metrics", enrichPublisherMetrics);
router.get("/publishers/suggested", getSuggestedPublishers); // Get suggested publishers
router.post("/publishers/suggestions/mark-reviewed", markSuggestionsAsReviewed); // Mark as reviewed

// ============================================
// Campaign Routes
// ============================================
router.post("/campaigns", createCampaign);
router.get("/campaigns", getCampaigns);
router.get("/campaigns/:id", getCampaignById);
router.put("/campaigns/:id", updateCampaign);
router.delete("/campaigns/:id", deleteCampaign);
router.get("/campaigns/:id/analytics", getCampaignAnalytics);

// ============================================
// Submission Routes
// ============================================
router.post("/submissions", createSubmission);
router.get("/submissions", getSubmissions);
router.get("/submissions/:id", getSubmissionById);
router.put("/submissions/:id", updateSubmission);
router.post("/submissions/:id/status", updateSubmissionStatus);
router.delete("/submissions/:id", deleteSubmission);

// ============================================
// Email Automation Routes
// ============================================
router.post("/submissions/:id/generate-pitch", generatePitchEmail);
router.post("/submissions/:id/send-pitch", sendPitchEmail);
router.post("/submissions/:id/check-published", checkPublishedPost);
router.post("/submissions/:id/check-reply", checkEmailReply);
router.get("/imap-status", checkIMAPStatus);

// ============================================
// Analytics Routes
// ============================================
router.get("/publishers/:id/performance", getPublisherPerformance);

// ============================================
// Discovery Routes
// ============================================
router.post("/publishers/discover", discoverPublishers);
router.post("/publishers/discover/reddit", discoverFromReddit);
router.post("/publishers/discover/medium", discoverFromMedium);
router.post("/publishers/discover/competitors", discoverFromCompetitors);
router.post("/publishers/discover/analyze", analyzePublisherUrl);
router.post("/publishers/bulk-create", bulkCreatePublishers);

export default router;
