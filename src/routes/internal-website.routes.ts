import { Router } from "express";
import { requireInternalOnboardingSecret } from "../middleware/require-internal-secret";
import { internalTriggerOnboarding } from "../controllers/website.controller";

const InternalWebsiteRouter: Router = Router();

InternalWebsiteRouter.use(requireInternalOnboardingSecret);
InternalWebsiteRouter.post("/trigger-onboarding", internalTriggerOnboarding);

export default InternalWebsiteRouter;
