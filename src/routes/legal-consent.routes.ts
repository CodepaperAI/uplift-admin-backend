import { Router } from "express";

import {
  acceptLegalConsent,
  getLegalConsent,
} from "../controllers/legal-consent.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const LegalConsentRouter = Router();
LegalConsentRouter.use(requireBackendAuth);
LegalConsentRouter.get("/", getLegalConsent);
LegalConsentRouter.post(
  "/",
  sensitiveRouteRateLimit({
    namespace: "legal-consent-write",
    limit: 10,
    windowSeconds: 60,
  }),
  acceptLegalConsent,
);

export default LegalConsentRouter;
