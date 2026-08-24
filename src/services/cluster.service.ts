import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { getClustersByBusiness, getClusterDetails } from "../controllers/cluster.controller";

const ClusterRouter: Router = Router();

ClusterRouter.use(requireBackendAuth);
ClusterRouter.post("/list", getClustersByBusiness);
ClusterRouter.post("/details", getClusterDetails);

export default ClusterRouter;
