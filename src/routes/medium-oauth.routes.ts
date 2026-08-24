import { Router } from "express";
import {
  authorizeMedium,
  handleMediumCallback,
  disconnectMedium,
  getMediumStatus,
} from "../controllers/medium-oauth.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const router = Router();

router.get(
  "/auth/medium/authorize",
  requireBackendAuth,
  bindAuthenticatedUser,
  authorizeMedium,
);
router.get("/auth/medium/callback", handleMediumCallback);
router.post(
  "/auth/medium/disconnect",
  requireBackendAuth,
  bindAuthenticatedUser,
  disconnectMedium,
);
router.get(
  "/auth/medium/status",
  requireBackendAuth,
  bindAuthenticatedUser,
  getMediumStatus,
);

export default router;
