import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { requireAgencyAdmin } from "../middleware/require-agency-admin";
import {
  getAgencyOverview,
  listAgencyBusinesses,
  getAgencyPricing,
  updateAgencyPricing,
  getAgencySettlements,
  getAgencySettlementDetail,
  getAgencyLedger,
} from "../controllers/agency-admin.controller";

const agencyAdminRouter: Router = Router();

agencyAdminRouter.use(requireBackendAuth);
agencyAdminRouter.use(requireAgencyAdmin);

agencyAdminRouter.get("/overview", getAgencyOverview);
agencyAdminRouter.get("/businesses", listAgencyBusinesses);
agencyAdminRouter.get("/pricing", getAgencyPricing);
agencyAdminRouter.patch("/pricing", updateAgencyPricing);
agencyAdminRouter.get("/settlements", getAgencySettlements);
agencyAdminRouter.get("/settlements/:runId", getAgencySettlementDetail);
agencyAdminRouter.get("/ledger", getAgencyLedger);

export default agencyAdminRouter;
