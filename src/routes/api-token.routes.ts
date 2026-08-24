import { Router } from "express";
import {
    createApiToken,
    deleteApiToken,
    listApiTokens,
    regenerateApiToken,
    revokeApiToken,
} from "../controllers/api-token.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const ApiTokenRouter: Router = Router();

ApiTokenRouter.use(requireBackendAuth);
ApiTokenRouter.use(
    sensitiveRouteRateLimit({ namespace: "api-token-admin", limit: 60, windowSeconds: 60 }),
);
ApiTokenRouter.post("/create", createApiToken);
ApiTokenRouter.post("/list", listApiTokens);
ApiTokenRouter.post("/revoke", revokeApiToken);
ApiTokenRouter.post("/regenerate", regenerateApiToken);
ApiTokenRouter.post("/delete", deleteApiToken);

export default ApiTokenRouter;
