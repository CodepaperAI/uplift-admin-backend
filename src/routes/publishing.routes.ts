import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  connectIntegration,
  updateIntegration,
  getIntegrations,
  disconnectIntegration,
  testConnection,
  publishBlog,
  getPublishedBlogs,
} from "../controllers/publishing.controller";

const router = Router();

router.use(requireBackendAuth);
router.post("/connect", connectIntegration);
router.put("/:integrationId", updateIntegration);
router.get("/user/:userId", getIntegrations);
router.delete("/:integrationId", disconnectIntegration);
router.post("/test-connection", testConnection);
router.post("/publish", publishBlog);
router.get("/published/:userId", getPublishedBlogs);

export default router;

