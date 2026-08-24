import { Router } from "express";
import { getEmailPreviews, sendOnboardingFollowUpEmail, sendOnboardingReminderEmail, sendSubscriptionEmail, sendWelcomeEmail } from "../controllers/email.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { requireInternalTransactionalEmailSecret } from "../middleware/require-internal-secret";

const EmailRouter: Router = Router();

EmailRouter.post("/subscription", requireInternalTransactionalEmailSecret, sendSubscriptionEmail);
EmailRouter.post("/welcome", requireInternalTransactionalEmailSecret, sendWelcomeEmail);
EmailRouter.post(
  "/onboarding-reminder",
  requireInternalTransactionalEmailSecret,
  sendOnboardingReminderEmail,
);
EmailRouter.post(
  "/onboarding-follow-up",
  requireInternalTransactionalEmailSecret,
  sendOnboardingFollowUpEmail,
);
EmailRouter.get("/previews", requireBackendAuth, getEmailPreviews);

export default EmailRouter;
