import { Router } from "express";
import { getAddressAutocomplete } from "../controllers/location.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";

const LocationRouter = Router();

LocationRouter.use(requireBackendAuth);
LocationRouter.get(
  "/address-autocomplete",
  sensitiveRouteRateLimit({
    namespace: "address-autocomplete",
    limit: 24,
    windowSeconds: 60,
  }),
  getAddressAutocomplete,
);

export default LocationRouter;
