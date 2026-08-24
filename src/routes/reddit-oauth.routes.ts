import { Router } from "express";
import {
  authorizeReddit,
  handleRedditCallback,
  disconnectReddit,
  getRedditStatus,
} from "../controllers/reddit-oauth.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const router = Router();

router.get(
  "/auth/reddit/authorize",
  requireBackendAuth,
  bindAuthenticatedUser,
  authorizeReddit,
);
router.get("/auth/reddit/callback", handleRedditCallback);
router.post(
  "/auth/reddit/disconnect",
  requireBackendAuth,
  bindAuthenticatedUser,
  disconnectReddit,
);
router.get(
  "/auth/reddit/status",
  requireBackendAuth,
  bindAuthenticatedUser,
  getRedditStatus,
);

export default router;
