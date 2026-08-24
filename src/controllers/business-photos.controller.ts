import { BusinessPhotoCategory } from "@prisma/client";
import type { Response } from "express";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  listBusinessPhotos,
  removeBusinessPhoto,
  updateBusinessPhoto,
  uploadBusinessPhoto,
} from "../services/business-photos.service";
import { sendError, sendSuccess } from "../utils/response.utils";
import { z } from "zod";
import {
  inspectImageUpload,
  OnboardingV2AuthorImageValidationError,
} from "../services/onboarding-v2-author-image.service";

const BUSINESS_ID_BODY = z.object({ businessId: z.string().uuid() }).strict();
const PHOTO_PATCH_BODY = z.object({
  photoId: z.string().uuid(),
  businessId: z.string().uuid(),
  altText: z.string().trim().max(500).nullable().optional(),
  category: z.enum(["EXTERIOR", "INTERIOR", "TEAM", "PRODUCT", "WORK_SAMPLE", "OTHER"]).optional(),
  order: z.number().int().min(0).max(10_000).optional(),
}).strict();
const PHOTO_DELETE_BODY = z.object({
  photoId: z.string().uuid(),
  businessId: z.string().uuid(),
}).strict();

const ALLOWED_CATEGORIES: ReadonlySet<BusinessPhotoCategory> = new Set([
  "EXTERIOR",
  "INTERIOR",
  "TEAM",
  "PRODUCT",
  "WORK_SAMPLE",
  "OTHER",
]);

async function assertOwnership(
  req: AuthenticatedRequest,
  businessId: string,
): Promise<boolean> {
  const userId = req.authUserId;
  if (!userId) return false;
  const biz = await prisma.business.findFirst({
    where: { id: businessId, userId },
    select: { id: true },
  });
  return Boolean(biz);
}

export async function listPhotos(req: AuthenticatedRequest, res: Response) {
  try {
    const parsed = BUSINESS_ID_BODY.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Invalid request", 400);
    const { businessId } = parsed.data;
    if (!(await assertOwnership(req, businessId))) {
      return sendError(res, "Forbidden", 403);
    }
    const photos = await listBusinessPhotos(businessId);
    return sendSuccess(res, { photos });
  } catch (err: any) {
    console.error("[business-photos] list error:", err);
    return sendError(res, err.message, 500);
  }
}

export async function uploadPhoto(req: AuthenticatedRequest, res: Response) {
  try {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return sendError(res, "file required (multipart/form-data)", 400);

    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some(
        (key) => !["businessId", "category", "altText"].includes(key),
      )
    ) {
      return sendError(res, "Invalid request", 400);
    }
    const businessId = String(req.body.businessId ?? "").trim();
    if (!z.string().uuid().safeParse(businessId).success) {
      return sendError(res, "Invalid request", 400);
    }
    if (!(await assertOwnership(req, businessId))) {
      return sendError(res, "Forbidden", 403);
    }

    const rawCategory = String(req.body.category ?? "OTHER").toUpperCase();
    if (!ALLOWED_CATEGORIES.has(rawCategory as BusinessPhotoCategory)) {
      return sendError(res, "Invalid request", 400);
    }
    const category = rawCategory as BusinessPhotoCategory;

    if (req.body.altText !== undefined && typeof req.body.altText !== "string") {
      return sendError(res, "Invalid request", 400);
    }
    const altText = typeof req.body.altText === "string"
      ? req.body.altText.trim()
      : null;
    if ((altText?.length ?? 0) > 500) {
      return sendError(res, "Invalid request", 400);
    }

    let inspection;
    try {
      inspection = inspectImageUpload(file.buffer, file.mimetype, {
        maxBytes: 10 * 1024 * 1024,
        maxDimension: 8_192,
        maxPixels: 40_000_000,
      });
    } catch (error) {
      if (error instanceof OnboardingV2AuthorImageValidationError) {
        return sendError(res, error.message, error.statusCode);
      }
      throw error;
    }

    const photo = await uploadBusinessPhoto({
      businessId,
      buffer: file.buffer,
      mimeType: inspection.mimeType,
      altText,
      category,
    });
    return sendSuccess(res, { photo });
  } catch (err: any) {
    console.error("[business-photos] upload error:", err);
    return sendError(res, err.message, 500);
  }
}

export async function patchPhoto(req: AuthenticatedRequest, res: Response) {
  try {
    const parsed = PHOTO_PATCH_BODY.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Invalid request", 400);
    const { photoId, businessId, altText, category, order } = parsed.data;
    if (!(await assertOwnership(req, businessId))) {
      return sendError(res, "Forbidden", 403);
    }
    // Confirm the photo actually belongs to this business.
    const owned = await prisma.businessPhoto.findFirst({
      where: { id: photoId, businessId },
      select: { id: true },
    });
    if (!owned) return sendError(res, "Photo not found", 404);

    const patch: {
      altText?: string | null;
      category?: BusinessPhotoCategory;
      order?: number;
    } = {};
    if (altText !== undefined) patch.altText = altText ?? null;
    if (category !== undefined) {
      if (ALLOWED_CATEGORIES.has(category as BusinessPhotoCategory)) {
        patch.category = category as BusinessPhotoCategory;
      }
    }
    if (order !== undefined && typeof order === "number") patch.order = order;

    const photo = await updateBusinessPhoto(photoId, patch);
    return sendSuccess(res, { photo });
  } catch (err: any) {
    console.error("[business-photos] patch error:", err);
    return sendError(res, err.message, 500);
  }
}

export async function deletePhoto(req: AuthenticatedRequest, res: Response) {
  try {
    const parsed = PHOTO_DELETE_BODY.safeParse(req.body);
    if (!parsed.success) return sendError(res, "Invalid request", 400);
    const { photoId, businessId } = parsed.data;
    if (!(await assertOwnership(req, businessId))) {
      return sendError(res, "Forbidden", 403);
    }
    const owned = await prisma.businessPhoto.findFirst({
      where: { id: photoId, businessId },
      select: { id: true },
    });
    if (!owned) return sendError(res, "Photo not found", 404);

    await removeBusinessPhoto(photoId);
    return sendSuccess(res, { deleted: true });
  } catch (err: any) {
    console.error("[business-photos] delete error:", err);
    return sendError(res, err.message, 500);
  }
}
