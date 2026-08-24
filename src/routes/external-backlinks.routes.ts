import { Router } from "express";
import {
  getBacklinkSummary,
  getBacklinks,
  getReferringDomains,
  getAnchorTexts,
  syncBacklinks,
  getBacklinkStats,
  getBacklinkSettings,
  updateBacklinkEnabled,
} from "../controllers/external-backlinks.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";

const router = Router();

router.use(requireBackendAuth);
router.use(bindAuthenticatedUser);

router.get("/summary", getBacklinkSummary);
router.get("/backlinks", getBacklinks);
router.get("/referring-domains", getReferringDomains);
router.get("/anchors", getAnchorTexts);
router.post("/sync", syncBacklinks);
router.get("/stats", getBacklinkStats);
router.get("/settings", getBacklinkSettings);
router.put("/settings", updateBacklinkEnabled);
// Route-level binding is intentional. Express has not populated `req.params`
// yet when router-level middleware runs, so legacy identity parameters must be
// checked again after the parameterized route has matched.
router.get("/:userId/summary", bindAuthenticatedUser, getBacklinkSummary);
router.get("/:userId/backlinks", bindAuthenticatedUser, getBacklinks);
router.get("/:userId/referring-domains", bindAuthenticatedUser, getReferringDomains);
router.get("/:userId/anchors", bindAuthenticatedUser, getAnchorTexts);
router.post("/:userId/sync", bindAuthenticatedUser, syncBacklinks);
router.get("/:userId/stats", bindAuthenticatedUser, getBacklinkStats);

export default router;
