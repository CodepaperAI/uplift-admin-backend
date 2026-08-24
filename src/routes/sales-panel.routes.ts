import { Router } from "express";
import {
  assignSalesCustomer,
  createSalesEntry,
  createSalesNote,
  getSalesAssignments,
  getSalesDashboard,
  searchSalesCustomers,
} from "../controllers/sales-panel.controller";
import { requireSalesSession } from "../middleware/require-sales-session";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const SalesPanelRouter = Router();
SalesPanelRouter.use(requireSalesSession);
SalesPanelRouter.get("/dashboard", getSalesDashboard);
SalesPanelRouter.get("/assignments", getSalesAssignments);
SalesPanelRouter.get("/customers/search", searchSalesCustomers);
SalesPanelRouter.post(
  "/assignments",
  sensitiveRouteRateLimit({ namespace: "sales-assign", limit: 30, windowSeconds: 60 }),
  assignSalesCustomer,
);
SalesPanelRouter.post(
  "/assignments/:assignmentId/notes",
  sensitiveRouteRateLimit({ namespace: "sales-note", limit: 60, windowSeconds: 60 }),
  createSalesNote,
);
SalesPanelRouter.post(
  "/assignments/:assignmentId/sales",
  sensitiveRouteRateLimit({ namespace: "sales-entry", limit: 30, windowSeconds: 60 }),
  createSalesEntry,
);

export default SalesPanelRouter;
