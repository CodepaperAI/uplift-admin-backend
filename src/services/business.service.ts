import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  updateBusinessLocation,
  updateBusinessPreferences,
  updateBusinessBlogUrls,
  updateBusinessAuthorProfile,
} from "../controllers/business-onboarding.controller";
import {
  createBusiness,
  deleteBlogImage,
  getBlogImages,
  getBrandAnalysisStatus,
  getBusinessInfo,
  getSitemapUrl,
  triggerBlogImageExtraction,
  triggerBrandAnalysis,
  updateBlogImageSelection,
  uploadBusinessAuthorImage,
  uploadBusinessBrandLogoController,
  uploadBlogImage,
} from "../controllers/business.controller";
import { ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES } from "./onboarding-v2-author-image.service";
import { ONBOARDING_V2_BRAND_LOGO_MAX_BYTES } from "./onboarding-v2-brand-logo.service";
import { sendError } from "../utils/response.utils";
import {
  authorizeBusinessAccess,
  createBusinessCompetitor,
  createBusinessKeyword,
  createBusinessRanking,
  deleteBusinessCompetitor,
  deleteBusinessKeyword,
  deleteBusinessRanking,
  getBlogContentSettings,
  getBusinessSettings,
  getBusinessSitemap,
  replaceBusinessAdvantages,
  updateBusinessBasicSettings,
  updateBusinessCompetitor,
  updateBusinessKeyword,
  updateBusinessLocale,
  updateBusinessRanking,
  updateBlogContentSettings,
} from "../controllers/business-settings.controller";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 2,
    parts: 3,
  },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WebP image files are allowed"));
    }
  },
});

function blogImageUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, "Image must be 10 MB or smaller", 413);
      return;
    }
    sendError(res, "Invalid image upload", 400);
  });
}

const businessAuthorImageParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES,
    files: 1,
    fields: 2,
    parts: 3,
  },
});

export function businessAuthorImageUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  businessAuthorImageParser.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, "Author image must be 1 MB or smaller", 413, {
        code: "BUSINESS_AUTHOR_IMAGE_TOO_LARGE",
        message: "Author image must be 1 MB or smaller.",
      });
      return;
    }
    sendError(res, "Invalid author image upload", 400, {
      code: "BUSINESS_AUTHOR_IMAGE_MULTIPART_INVALID",
      message:
        error instanceof Error ? error.message : "Invalid multipart image upload.",
    });
  });
}

const businessBrandLogoParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ONBOARDING_V2_BRAND_LOGO_MAX_BYTES,
    files: 1,
    fields: 2,
    parts: 3,
  },
});

export function businessBrandLogoUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  businessBrandLogoParser.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, "Brand logo must be 8 MB or smaller", 413, {
        code: "BUSINESS_BRAND_LOGO_TOO_LARGE",
        message: "Brand logo must be 8 MB or smaller.",
      });
      return;
    }
    sendError(res, "Invalid brand logo upload", 400, {
      code: "BUSINESS_BRAND_LOGO_MULTIPART_INVALID",
      message:
        error instanceof Error ? error.message : "Invalid multipart image upload.",
    });
  });
}

const BusinessRouter: Router = Router();

BusinessRouter.use(requireBackendAuth);
BusinessRouter.post("/create", createBusiness);
BusinessRouter.post("/info", getBusinessInfo);
BusinessRouter.post("/access", authorizeBusinessAccess);
BusinessRouter.post("/settings/info", getBusinessSettings);
BusinessRouter.post("/settings/blog-content", getBlogContentSettings);
BusinessRouter.post("/settings/blog-content/update", updateBlogContentSettings);
BusinessRouter.post("/settings/sitemap", getBusinessSitemap);
BusinessRouter.post("/settings/basic", updateBusinessBasicSettings);
BusinessRouter.post("/settings/keywords/create", createBusinessKeyword);
BusinessRouter.post("/settings/keywords/update", updateBusinessKeyword);
BusinessRouter.post("/settings/keywords/delete", deleteBusinessKeyword);
BusinessRouter.post("/settings/advantages/replace", replaceBusinessAdvantages);
BusinessRouter.post("/settings/competitors/create", createBusinessCompetitor);
BusinessRouter.post("/settings/competitors/update", updateBusinessCompetitor);
BusinessRouter.post("/settings/competitors/delete", deleteBusinessCompetitor);
BusinessRouter.post("/settings/rankings/create", createBusinessRanking);
BusinessRouter.post("/settings/rankings/update", updateBusinessRanking);
BusinessRouter.post("/settings/rankings/delete", deleteBusinessRanking);
BusinessRouter.post("/settings/locale", updateBusinessLocale);
BusinessRouter.post("/get-sitemap-url", getSitemapUrl);
BusinessRouter.post("/update-location", updateBusinessLocation);
BusinessRouter.post("/update-preferences", updateBusinessPreferences);
BusinessRouter.post("/update-blog-urls", updateBusinessBlogUrls);
BusinessRouter.post("/update-author-profile", updateBusinessAuthorProfile);
BusinessRouter.post("/brand-analysis-status", getBrandAnalysisStatus);
BusinessRouter.post("/trigger-brand-analysis", triggerBrandAnalysis);
BusinessRouter.post("/blog-images", getBlogImages);
BusinessRouter.post("/delete-blog-image", deleteBlogImage);
BusinessRouter.post("/update-blog-image-selection", updateBlogImageSelection);
BusinessRouter.post(
  "/upload-blog-image",
  blogImageUpload,
  uploadBlogImage
);
BusinessRouter.post(
  "/upload-author-image",
  businessAuthorImageUpload,
  uploadBusinessAuthorImage,
);
BusinessRouter.post(
  "/upload-brand-logo",
  businessBrandLogoUpload,
  uploadBusinessBrandLogoController,
);
BusinessRouter.post(
  "/trigger-blog-image-extraction",
  triggerBlogImageExtraction
);

export default BusinessRouter;
