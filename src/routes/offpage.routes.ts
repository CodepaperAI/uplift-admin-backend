import { Router } from "express";
import {
  getOffPageOpportunitiesHandler,
  updateOffPageOpportunityStatusHandler,
  verifyOffPageOpportunityHandler,
} from "../controllers/offpage.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";

const router = Router();

router.use(requireBackendAuth, bindAuthenticatedUser);

// Canonical tenant-safe routes. The signed backend token supplies the user;
// businessId is still independently ownership-checked by the controller.
router.get("/opportunities", getOffPageOpportunitiesHandler);
router.post("/opportunity-status", updateOffPageOpportunityStatusHandler);
router.post("/opportunity-verify", verifyOffPageOpportunityHandler);

// Temporary compatibility aliases. bindAuthenticatedUser rejects a path user
// that differs from the signed identity before these handlers can run.
router.get(
  "/:userId/opportunities",
  bindAuthenticatedUser,
  getOffPageOpportunitiesHandler,
);
router.post(
  "/:userId/opportunity-status",
  bindAuthenticatedUser,
  updateOffPageOpportunityStatusHandler,
);
router.post(
  "/:userId/opportunity-verify",
  bindAuthenticatedUser,
  verifyOffPageOpportunityHandler,
);

export default router;
