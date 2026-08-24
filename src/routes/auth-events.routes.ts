import { Router } from "express";
import { syncSignupCreatedEvent } from "../controllers/auth-events.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const AuthEventsRouter = Router();

AuthEventsRouter.use(requireBackendAuth);
AuthEventsRouter.post(
  "/signup-created",
  sensitiveRouteRateLimit({
    namespace: "auth-event-signup-created",
    limit: 5,
    windowSeconds: 24 * 60 * 60,
  }),
  syncSignupCreatedEvent,
);

export default AuthEventsRouter;
