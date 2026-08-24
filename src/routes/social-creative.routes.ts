import { Router } from "express";

import {
  getSocialCreativeRun,
  listSocialCalendar,
  listSocialCreativeRuns,
  requestSocialCreativeGeneration,
  requestSocialTopicPlan,
  retryFailedSocialCreativeAssets,
} from "../controllers/social-creative.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const SocialCreativeRouter: Router = Router();

SocialCreativeRouter.use(requireBackendAuth);
SocialCreativeRouter.post("/generate", requestSocialCreativeGeneration);
SocialCreativeRouter.post("/topics/plan", requestSocialTopicPlan);
SocialCreativeRouter.post(
  "/generate-website-campaign",
  requestSocialCreativeGeneration,
);
SocialCreativeRouter.get("/runs", listSocialCreativeRuns);
SocialCreativeRouter.get("/calendar", listSocialCalendar);
SocialCreativeRouter.post("/runs/:runId/retry-failed", retryFailedSocialCreativeAssets);
SocialCreativeRouter.get("/runs/:runId", getSocialCreativeRun);

export default SocialCreativeRouter;
