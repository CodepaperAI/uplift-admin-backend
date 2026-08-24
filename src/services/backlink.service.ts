import { Router } from "express";
import {
  GetAllBacklinks,
  GetBacklinkOverview,
} from "../controllers/backlink.controller";
import { bindAuthenticatedUser } from "../middleware/bind-authenticated-user";
import { requireBackendAuth } from "../middleware/require-backend-auth";

const BacklinkRouter = Router();

BacklinkRouter.post(
  "/all",
  requireBackendAuth,
  bindAuthenticatedUser,
  GetAllBacklinks,
);

BacklinkRouter.post(
  "/overview",
  requireBackendAuth,
  bindAuthenticatedUser,
  GetBacklinkOverview,
);

export default BacklinkRouter;
