import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { correlationIdMiddleware } from "../middleware/correlation-id";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  beginSecondaryOnboardingV2,
  completeSecondaryOnboardingV2,
  getOnboardingV2Preview,
  getOnboardingV2State,
  listSecondaryOnboardingV2Sessions,
  patchOnboardingV2State,
  quickScrape,
  saveBusinessDetails,
  saveSelectedServices,
  searchQuickPlaces,
  startOnboardingV2Generation,
  uploadOnboardingV2AuthorImageController,
  uploadOnboardingV2BrandLogoController,
} from "../controllers/quick-scrape.controller";
import { ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES } from "./onboarding-v2-author-image.service";
import { ONBOARDING_V2_BRAND_LOGO_MAX_BYTES } from "./onboarding-v2-brand-logo.service";
import { sendError } from "../utils/response.utils";

const onboardingV2AuthorImageParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES,
    files: 1,
    fields: 4,
    parts: 5,
  },
});

export function onboardingV2AuthorImageUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  onboardingV2AuthorImageParser.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, "Author image must be 1 MB or smaller", 413, {
        code: "ONBOARDING_V2_AUTHOR_IMAGE_TOO_LARGE",
        message: "Author image must be 1 MB or smaller.",
      });
      return;
    }
    sendError(res, "Invalid author image upload", 400, {
      code: "ONBOARDING_V2_AUTHOR_IMAGE_MULTIPART_INVALID",
      message:
        error instanceof Error ? error.message : "Invalid multipart image upload.",
    });
  });
}

const onboardingV2BrandLogoParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ONBOARDING_V2_BRAND_LOGO_MAX_BYTES,
    files: 1,
    fields: 4,
    parts: 5,
  },
});

export function onboardingV2BrandLogoUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  onboardingV2BrandLogoParser.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, "Brand logo must be 8 MB or smaller", 413, {
        code: "ONBOARDING_V2_BRAND_LOGO_TOO_LARGE",
        message: "Brand logo must be 8 MB or smaller.",
      });
      return;
    }
    sendError(res, "Invalid brand logo upload", 400, {
      code: "ONBOARDING_V2_BRAND_LOGO_MULTIPART_INVALID",
      message:
        error instanceof Error ? error.message : "Invalid multipart image upload.",
    });
  });
}

const QuickScrapeRouter: Router = Router();

QuickScrapeRouter.post("/scrape", correlationIdMiddleware, requireBackendAuth, quickScrape);
QuickScrapeRouter.post("/save-services", correlationIdMiddleware, requireBackendAuth, saveSelectedServices);
QuickScrapeRouter.post("/save-business-details", correlationIdMiddleware, requireBackendAuth, saveBusinessDetails);
QuickScrapeRouter.post("/search-places", correlationIdMiddleware, requireBackendAuth, searchQuickPlaces);
QuickScrapeRouter.get(
  "/onboarding-v2/state",
  correlationIdMiddleware,
  requireBackendAuth,
  getOnboardingV2State,
);
QuickScrapeRouter.post(
  "/onboarding-v2/secondary/begin",
  correlationIdMiddleware,
  requireBackendAuth,
  beginSecondaryOnboardingV2,
);
QuickScrapeRouter.get(
  "/onboarding-v2/secondary/sessions",
  correlationIdMiddleware,
  requireBackendAuth,
  listSecondaryOnboardingV2Sessions,
);
QuickScrapeRouter.post(
  "/onboarding-v2/complete-secondary",
  correlationIdMiddleware,
  requireBackendAuth,
  completeSecondaryOnboardingV2,
);
QuickScrapeRouter.patch(
  "/onboarding-v2/state",
  correlationIdMiddleware,
  requireBackendAuth,
  patchOnboardingV2State,
);
QuickScrapeRouter.post(
  "/onboarding-v2/author-image",
  correlationIdMiddleware,
  requireBackendAuth,
  onboardingV2AuthorImageUpload,
  uploadOnboardingV2AuthorImageController,
);
QuickScrapeRouter.post(
  "/onboarding-v2/brand-logo",
  correlationIdMiddleware,
  requireBackendAuth,
  onboardingV2BrandLogoUpload,
  uploadOnboardingV2BrandLogoController,
);
QuickScrapeRouter.post(
  "/onboarding-v2/start-generation",
  correlationIdMiddleware,
  requireBackendAuth,
  startOnboardingV2Generation,
);
QuickScrapeRouter.get(
  "/onboarding-v2/preview",
  correlationIdMiddleware,
  requireBackendAuth,
  getOnboardingV2Preview,
);

export default QuickScrapeRouter;
