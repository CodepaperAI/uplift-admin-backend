import { Router } from "express";
import multer from "multer";
import {
  deletePhoto,
  listPhotos,
  patchPhoto,
  uploadPhoto,
} from "../controllers/business-photos.controller";
import { requireBackendAuth } from "../middleware/require-backend-auth";
import type { NextFunction, Request, Response } from "express";
import { sendError } from "../utils/response.utils";

const BusinessPhotosRouter: Router = Router();

// Multer config matches business.service.ts: 10MB, image MIME types only.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 4,
    parts: 5,
  },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, and WebP image files are allowed"));
    }
  },
});

function businessPhotoUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("photo")(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(res, "Image must be 10 MB or smaller", 413);
      return;
    }
    sendError(res, "Invalid image upload", 400);
  });
}

BusinessPhotosRouter.use(requireBackendAuth);

BusinessPhotosRouter.post("/list", listPhotos);
BusinessPhotosRouter.post("/upload", businessPhotoUpload, uploadPhoto);
BusinessPhotosRouter.post("/update", patchPhoto);
BusinessPhotosRouter.post("/delete", deletePhoto);

export default BusinessPhotosRouter;
