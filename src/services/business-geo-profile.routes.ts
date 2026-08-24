import { Router } from "express";
import {
  autoEnrichGeoProfile,
  getGeoProfileStatus,
  resolveGeoProfile,
  searchPlaces,
} from "../controllers/business-geo-profile.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const BusinessGeoProfileRouter: Router = Router();

BusinessGeoProfileRouter.use(requireBackendAuth);

BusinessGeoProfileRouter.post("/status", getGeoProfileStatus);
BusinessGeoProfileRouter.post("/search", searchPlaces);
BusinessGeoProfileRouter.post("/resolve", resolveGeoProfile);
BusinessGeoProfileRouter.post("/auto-enrich", autoEnrichGeoProfile);

export default BusinessGeoProfileRouter;
