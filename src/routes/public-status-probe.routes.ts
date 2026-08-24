import { Router } from "express";

import { getPublicStatusProbe } from "../controllers/public-status-probe.controller";
import { requireStatusProbe } from "../middleware/require-status-probe";

const router: Router = Router();

router.get("/:component", requireStatusProbe, getPublicStatusProbe);

export default router;
