import { Router } from "express";
import { correlationIdMiddleware } from "../middleware/correlation-id";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  checkTrialStatus,
  enrollInTrial,
  getQuickKeywordsForTrial,
  getTopKeywords,
  startQuickKeywords,
  testQuickKeywordsForAllBusinessTypes,
  testSendTopKeywordsEmail,
  triggerCompleteOnboardingAfterPayment,
} from "../controllers/trial.controller";

const TrialRouter: Router = Router();

TrialRouter.post("/enroll", correlationIdMiddleware, requireBackendAuth, enrollInTrial);
TrialRouter.post(
  "/trigger-complete-onboarding",
  correlationIdMiddleware,
  requireBackendAuth,
  triggerCompleteOnboardingAfterPayment,
);
TrialRouter.post("/status", correlationIdMiddleware, requireBackendAuth, checkTrialStatus);
TrialRouter.post("/quick-keywords", correlationIdMiddleware, requireBackendAuth, getQuickKeywordsForTrial);
TrialRouter.post("/start-quick-keywords", correlationIdMiddleware, requireBackendAuth, startQuickKeywords);
TrialRouter.post("/top-keywords", correlationIdMiddleware, requireBackendAuth, getTopKeywords);
TrialRouter.post("/test-send-top-keywords-email", correlationIdMiddleware, requireBackendAuth, testSendTopKeywordsEmail);
TrialRouter.post(
  "/test-quick-keywords-all-business-types",
  correlationIdMiddleware,
  requireBackendAuth,
  testQuickKeywordsForAllBusinessTypes,
);

export default TrialRouter;
