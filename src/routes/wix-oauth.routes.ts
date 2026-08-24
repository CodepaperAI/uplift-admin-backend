import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import {
  authorizeWix,
  connectWixInstance,
  handleWixCallback,
  refreshWixToken,
} from "../controllers/wix-oauth.controller";

const router = Router();

router.get(
  "/auth/wix/authorize",
  requireBackendAuth,
  bindAuthenticatedUser,
  authorizeWix,
);
router.get("/auth/wix/callback", handleWixCallback);
router.post("/auth/wix/connect-instance", requireBackendAuth, connectWixInstance);
router.post(
  "/auth/wix/refresh",
  requireBackendAuth,
  bindAuthenticatedUser,
  refreshWixToken,
);

export default router;
