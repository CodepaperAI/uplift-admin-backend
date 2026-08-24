import { Router } from "express";

import {
  getAccountContext,
  getAccountSecurity,
  getDashboardAccess,
  getPostAuthDestination,
} from "../controllers/account-context.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const AccountContextRouter = Router();
AccountContextRouter.use(requireBackendAuth);
AccountContextRouter.get("/context", getAccountContext);
AccountContextRouter.get("/security", getAccountSecurity);
AccountContextRouter.get("/post-auth-destination", getPostAuthDestination);
AccountContextRouter.get("/dashboard-access", getDashboardAccess);

export default AccountContextRouter;
