import { BusinessPhotoCategory, Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { uploadImageBuffer } from "../lib/image-storage";

/**
 * BusinessPhoto service (D14)
 * ----------------------------------------------------------------------------
 * Customer-uploaded real photos used by the blog generator for E-E-A-T on
 * local / service-page content. AI-generated images fall back to gap filler.
 */

export interface BusinessPhotoRecord {
  id: string;
  businessId: string;
  url: string;
  altText: string | null;
  category: BusinessPhotoCategory;
  order: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listBusinessPhotos(
  businessId: string,
): Promise<BusinessPhotoRecord[]> {
  return prisma.businessPhoto.findMany({
    where: { businessId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}

export interface UploadPhotoInput {
  businessId: string;
  buffer: Buffer;
  mimeType: string;
  altText?: string | null;
  category?: BusinessPhotoCategory;
  width?: number | null;
  height?: number | null;
}

export async function uploadBusinessPhoto(
  input: UploadPhotoInput,
): Promise<BusinessPhotoRecord> {
  const url = await uploadImageBuffer(
    input.buffer,
    input.mimeType,
    `business-photos/${input.businessId}`,
  );

  const max = await prisma.businessPhoto.aggregate({
    where: { businessId: input.businessId },
    _max: { order: true },
  });
  const nextOrder = (max._max.order ?? -1) + 1;

  return prisma.businessPhoto.create({
    data: {
      businessId: input.businessId,
      url,
      altText: input.altText ?? null,
      category: input.category ?? "OTHER",
      order: nextOrder,
      width: input.width ?? null,
      height: input.height ?? null,
    },
  });
}

export interface UpdatePhotoInput {
  altText?: string | null;
  category?: BusinessPhotoCategory;
  order?: number;
}

export async function updateBusinessPhoto(
  photoId: string,
  patch: UpdatePhotoInput,
): Promise<BusinessPhotoRecord> {
  const data: Prisma.BusinessPhotoUpdateInput = {};
  if (patch.altText !== undefined) data.altText = patch.altText;
  if (patch.category !== undefined) data.category = patch.category;
  if (patch.order !== undefined) data.order = patch.order;
  return prisma.businessPhoto.update({
    where: { id: photoId },
    data,
  });
}

export async function removeBusinessPhoto(photoId: string): Promise<void> {
  await prisma.businessPhoto.delete({ where: { id: photoId } });
}

/**
 * Pick the top-N real photos for blog generation context. Prioritization:
 *   1. Explicit author-set order (`order` field — lower first)
 *   2. Category preference for service-page E-E-A-T:
 *      WORK_SAMPLE > INTERIOR > EXTERIOR > TEAM > PRODUCT > OTHER
 */
export async function getPreferredBlogPhotos(
  businessId: string,
  limit = 3,
): Promise<BusinessPhotoRecord[]> {
  const all = await listBusinessPhotos(businessId);
  const weight: Record<BusinessPhotoCategory, number> = {
    WORK_SAMPLE: 0,
    INTERIOR: 1,
    EXTERIOR: 2,
    TEAM: 3,
    PRODUCT: 4,
    OTHER: 5,
  };
  return [...all]
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return weight[a.category] - weight[b.category];
    })
    .slice(0, limit);
}
