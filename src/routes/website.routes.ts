import { Router } from "express";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  confirmSecondaryWebsiteDetails,
  createWebsite,
  createTrialSecondaryWebsite,
  createPaidSecondaryWebsite,
  getSecondaryWebsiteDraft,
  searchSecondaryWebsitePlaces,
  triggerOnboarding,
  deleteWebsite,
  listWebsites,
  retryWebsiteOnboarding,
  retryWebsiteRemoval,
  restoreWebsite,
  switchWebsite,
  updateWebsite,
} from "../controllers/website.controller";

const WebsiteRouter: Router = Router();

WebsiteRouter.use(requireBackendAuth);
WebsiteRouter.post("/create", createWebsite);
WebsiteRouter.post("/create-trial-secondary", createTrialSecondaryWebsite);
WebsiteRouter.post("/create-paid-secondary", createPaidSecondaryWebsite);
WebsiteRouter.post("/secondary-draft", getSecondaryWebsiteDraft);
WebsiteRouter.post("/secondary-search-places", searchSecondaryWebsitePlaces);
WebsiteRouter.post("/confirm-secondary-details", confirmSecondaryWebsiteDetails);
WebsiteRouter.post("/trigger-onboarding", triggerOnboarding);
WebsiteRouter.post("/list", listWebsites);
WebsiteRouter.patch("/update", updateWebsite);
WebsiteRouter.delete("/delete", deleteWebsite);
WebsiteRouter.post("/removal/retry", retryWebsiteRemoval);
WebsiteRouter.post("/restore", restoreWebsite);
WebsiteRouter.post("/switch", switchWebsite);
WebsiteRouter.post("/retry-onboarding", retryWebsiteOnboarding);

export default WebsiteRouter;
