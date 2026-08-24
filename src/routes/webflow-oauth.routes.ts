import { Router } from "express";
import {
  authorizeWebflow,
  handleWebflowCallback,
  refreshWebflowToken,
} from "../controllers/webflow-oauth.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const router = Router();

router.get(
  "/auth/webflow/authorize",
  requireBackendAuth,
  bindAuthenticatedUser,
  authorizeWebflow,
);
router.get("/auth/webflow/callback", handleWebflowCallback);
router.post(
  "/auth/webflow/refresh",
  requireBackendAuth,
  bindAuthenticatedUser,
  refreshWebflowToken,
);

export default router;
