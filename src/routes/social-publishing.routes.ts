import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";

import {
  createSocialConnectionUrl,
  disconnectSocialConnection,
  getSocialConnections,
  getSocialPublishingSettings,
  getSocialPromotionSettings,
  getSocialPublishingStatus,
  handleZernioWebhook,
  removeSocialReferenceImageController,
  requestSocialPublishing,
  retrySocialPublishing,
  selectDefaultSocialConnection,
  syncSocialConnections,
  removeSocialPromotionAsset,
  updateSocialPromotionSettings,
  updateSocialPublishingSettings,
  uploadSocialPromotionDocumentController,
  uploadSocialPromotionImageController,
  uploadSocialReferenceImagesController,
} from "../controllers/social-publishing.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import {
  SOCIAL_PROMOTION_DOCUMENT_MAX_BYTES,
  SOCIAL_PROMOTION_IMAGE_MAX_BYTES,
  SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE,
} from "../services/social-promotion.service";
import { sendError } from "../utils/response.utils";

const SocialPublishingRouter: Router = Router();

function promotionUpload(
  fieldName: "image" | "document",
  maximumBytes: number,
) {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maximumBytes, files: 1, fields: 2, parts: 3 },
  });
  return (req: Request, res: Response, next: NextFunction) => {
    parser.single(fieldName)(req, res, (error) => {
      if (!error) return next();
      if (
        error instanceof multer.MulterError &&
        error.code === "LIMIT_FILE_SIZE"
      ) {
        sendError(
          res,
          `Promotion ${fieldName} is too large`,
          413,
          {
            code: `SOCIAL_PROMOTION_${fieldName.toUpperCase()}_TOO_LARGE`,
            message:
              fieldName === "image"
                ? "Promotion image must be 5 MB or smaller."
                : "Promotion document must be 8 MB or smaller.",
          },
        );
        return;
      }
      sendError(res, `Invalid promotion ${fieldName} upload`, 400, {
        code: `SOCIAL_PROMOTION_${fieldName.toUpperCase()}_MULTIPART_INVALID`,
        message:
          error instanceof Error
            ? error.message
            : `Invalid multipart ${fieldName} upload.`,
      });
    });
  };
}

const promotionImageUpload = promotionUpload(
  "image",
  SOCIAL_PROMOTION_IMAGE_MAX_BYTES,
);
const promotionDocumentUpload = promotionUpload(
  "document",
  SOCIAL_PROMOTION_DOCUMENT_MAX_BYTES,
);
const referenceImageParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SOCIAL_PROMOTION_IMAGE_MAX_BYTES,
    files: SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE,
    fields: 2,
    parts: SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE + 2,
  },
});
const referenceImageUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  referenceImageParser.array(
    "images",
    SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE,
  )(req, res, (error) => {
    if (!error) return next();
    const tooLarge =
      error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    const tooMany =
      error instanceof multer.MulterError &&
      (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE");
    sendError(
      res,
      tooLarge ? "Reference image is too large" : "Invalid reference image upload",
      tooLarge ? 413 : 400,
      {
        code: tooLarge
          ? "SOCIAL_REFERENCE_IMAGE_TOO_LARGE"
          : tooMany
            ? "SOCIAL_REFERENCE_IMAGE_LIMIT"
            : "SOCIAL_REFERENCE_IMAGE_MULTIPART_INVALID",
        message: tooLarge
          ? "Each reference image must be 5 MB or smaller."
          : tooMany
            ? `Choose up to ${SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE} reference images.`
            : error instanceof Error
              ? error.message
              : "Invalid multipart reference image upload.",
      },
    );
  });
};

// Zernio signs this route with HMAC. It must remain outside Better Auth while
// every customer-facing connection and publishing route stays authenticated.
SocialPublishingRouter.post("/webhooks/zernio", handleZernioWebhook);

SocialPublishingRouter.use(requireBackendAuth);
SocialPublishingRouter.get("/connections", getSocialConnections);
SocialPublishingRouter.get("/settings", getSocialPublishingSettings);
SocialPublishingRouter.patch("/settings", updateSocialPublishingSettings);
SocialPublishingRouter.get("/promotion", getSocialPromotionSettings);
SocialPublishingRouter.patch("/promotion", updateSocialPromotionSettings);
SocialPublishingRouter.post(
  "/promotion/image",
  promotionImageUpload,
  uploadSocialPromotionImageController,
);
SocialPublishingRouter.post(
  "/promotion/document",
  promotionDocumentUpload,
  uploadSocialPromotionDocumentController,
);
SocialPublishingRouter.post(
  "/reference-images/:scope",
  referenceImageUpload,
  uploadSocialReferenceImagesController,
);
SocialPublishingRouter.delete(
  "/reference-images/:imageId",
  removeSocialReferenceImageController,
);
SocialPublishingRouter.delete(
  "/promotion/assets/:assetKind",
  removeSocialPromotionAsset,
);
SocialPublishingRouter.post("/connections/connect", createSocialConnectionUrl);
SocialPublishingRouter.post("/connections/sync", syncSocialConnections);
SocialPublishingRouter.delete(
  "/connections/:accountId",
  disconnectSocialConnection,
);
SocialPublishingRouter.patch(
  "/connections/:accountId/default",
  selectDefaultSocialConnection,
);
SocialPublishingRouter.post("/runs/:runId/publish", requestSocialPublishing);
SocialPublishingRouter.get("/runs/:runId/publishing", getSocialPublishingStatus);
SocialPublishingRouter.post(
  "/attempts/:attemptId/retry",
  retrySocialPublishing,
);

export default SocialPublishingRouter;
