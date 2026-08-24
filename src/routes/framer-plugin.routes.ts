import { Router } from "express";
import { framerPluginAudit } from "../controllers/framer-plugin-audit.controller";
import {
  framerPluginAuthorize,
  framerPluginExchange,
  framerPluginHandshakeStore,
  framerPluginPoll,
} from "../controllers/framer-plugin-handshake.controller";
import { framerPluginValidateKey } from "../controllers/framer-plugin-validate.controller";
import { framerPluginConnect } from "../controllers/framer-plugin-connect.controller";
import { publicApiCors } from "../middleware/public-api-cors";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

/**
 * Public (unauthenticated) routes — mounted at /api/public/v1/framer-plugin
 * Called by the Framer plugin running inside Framer's sandbox.
 */
const publicRouter: Router = Router();
publicRouter.use(publicApiCors);
publicRouter.post(
  "/audit",
  sensitiveRouteRateLimit({ namespace: "framer-audit", limit: 5, windowSeconds: 60 * 60 }),
  framerPluginAudit,
);
publicRouter.post(
  "/validate-key",
  sensitiveRouteRateLimit({ namespace: "framer-validate", limit: 10, windowSeconds: 60 * 60 }),
  framerPluginValidateKey,
);
publicRouter.post(
  "/authorize",
  sensitiveRouteRateLimit({ namespace: "framer-authorize", limit: 20, windowSeconds: 10 * 60 }),
  framerPluginAuthorize,
);
publicRouter.post(
  "/poll",
  sensitiveRouteRateLimit({ namespace: "framer-poll", limit: 180, windowSeconds: 10 * 60 }),
  framerPluginPoll,
);
publicRouter.post(
  "/exchange",
  sensitiveRouteRateLimit({ namespace: "framer-exchange", limit: 20, windowSeconds: 10 * 60 }),
  framerPluginExchange,
);

/**
 * Authenticated (better-auth session) routes — mounted at /api/v1/framer-plugin
 * - /handshake: called by the Uplift sign-up page through a signed Next.js proxy
 * - /connect: called by the Framer plugin with the single-use Bearer exchangeCode
 */
const authRouter: Router = Router();
authRouter.post("/handshake", requireBackendAuth, framerPluginHandshakeStore);
authRouter.post(
  "/connect",
  sensitiveRouteRateLimit({ namespace: "framer-connect", limit: 20, windowSeconds: 10 * 60 }),
  framerPluginConnect,
);

export { publicRouter as FramerPluginPublicRouter };
export default authRouter;
