import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  getLatestSeoAudit,
  getSeoAuditHistory,
  getSeoAuditStatus,
  triggerSeoAudit,
} from "../controllers/seo-audit.controller";

const SeoAuditRouter: Router = Router();

SeoAuditRouter.use(requireBackendAuth);

SeoAuditRouter.post("/trigger", triggerSeoAudit);
SeoAuditRouter.get("/status/:runId", getSeoAuditStatus);
SeoAuditRouter.get("/latest/:businessId", getLatestSeoAudit);
SeoAuditRouter.get("/history/:businessId", getSeoAuditHistory);

export default SeoAuditRouter;
