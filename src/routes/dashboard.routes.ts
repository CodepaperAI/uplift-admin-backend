import { Router } from "express";
import { getDashboardSnapshot } from "../controllers/dashboard.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const DashboardRouter = Router();

DashboardRouter.use(requireBackendAuth);
DashboardRouter.post("/snapshot", getDashboardSnapshot);

export default DashboardRouter;
