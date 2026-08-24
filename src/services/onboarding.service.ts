import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  OnboardingCompleted,
  completeOnboardingWithWebsite,
  getOnboardingEntryGuardStatus,
  getUserOnboardingStatus,
} from "../controllers/onboarding.controller";

const OnboardingRouter: Router = Router();

OnboardingRouter.use(requireBackendAuth);
OnboardingRouter.post("/complete-onboarding", OnboardingCompleted);
OnboardingRouter.post("/complete-with-website", completeOnboardingWithWebsite);
OnboardingRouter.get("/entry-guard", getOnboardingEntryGuardStatus);
OnboardingRouter.get("/status", getUserOnboardingStatus);

export default OnboardingRouter;
