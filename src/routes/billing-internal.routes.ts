import { Router } from "express";
import { requireInternalBillingSecret } from "../middleware/require-internal-secret";
import { handleBillingEvent } from "../controllers/billing-internal.controller";

const BillingInternalRouter: Router = Router();

BillingInternalRouter.post("/", requireInternalBillingSecret, handleBillingEvent);

export default BillingInternalRouter;
