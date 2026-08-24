import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  type ImageUploadReceipt,
  uploadImageBufferWithMetadata,
} from "../lib/image-storage";

export const ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES = 1 * 1024 * 1024;
export const ONBOARDING_V2_AUTHOR_IMAGE_MIN_DIMENSION = 256;
export const ONBOARDING_V2_AUTHOR_IMAGE_MAX_DIMENSION = 8_192;
export const ONBOARDING_V2_AUTHOR_IMAGE_MAX_PIXELS = 40_000_000;

const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class OnboardingV2AuthorImageValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "OnboardingV2AuthorImageValidationError";
  }
}

function normalizedMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, signature.length).equals(signature) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < 4 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8 ||
    buffer[2] !== 0xff
  ) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset] ?? 0;
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) break;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }

  return null;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < 25 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (declaredSize > buffer.length) return null;

  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b1 = buffer[21] ?? 0;
    const b2 = buffer[22] ?? 0;
    const b3 = buffer[23] ?? 0;
    const b4 = buffer[24] ?? 0;
    return {
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  if (
    chunk === "VP8 " &&
    buffer.length >= 30 &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function detectedImage(
  buffer: Buffer,
): { mimeType: string; width: number; height: number } | null {
  const png = pngDimensions(buffer);
  if (png) return { mimeType: "image/png", ...png };
  const jpeg = jpegDimensions(buffer);
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg };
  const webp = webpDimensions(buffer);
  if (webp) return { mimeType: "image/webp", ...webp };
  return null;
}

export type OnboardingV2AuthorImageInspection = {
  checksumSha256: string;
  height: number;
  mimeType: string;
  sizeBytes: number;
  width: number;
};

export type ImageUploadInspectionPolicy = {
  maxBytes: number;
  minDimension?: number;
  maxDimension: number;
  maxPixels: number;
};

export function inspectImageUpload(
  buffer: Buffer,
  declaredMimeType: string,
  policy: ImageUploadInspectionPolicy,
): OnboardingV2AuthorImageInspection {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_EMPTY",
      "Choose a non-empty image.",
    );
  }
  if (buffer.length > policy.maxBytes) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_TOO_LARGE",
      "The image file is too large.",
      413,
    );
  }

  const mimeType = normalizedMimeType(declaredMimeType);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_TYPE_INVALID",
      "Choose a JPEG, PNG, or WebP image.",
    );
  }
  const detected = detectedImage(buffer);
  if (!detected || detected.mimeType !== mimeType) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_SIGNATURE_INVALID",
      "The image contents do not match its declared file type.",
    );
  }

  const { width, height } = detected;
  const minDimension = policy.minDimension ?? 1;
  if (width < minDimension || height < minDimension) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_DIMENSIONS_TOO_SMALL",
      `The image must be at least ${minDimension} by ${minDimension} pixels.`,
    );
  }
  if (
    width > policy.maxDimension ||
    height > policy.maxDimension ||
    width * height > policy.maxPixels
  ) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_DIMENSIONS_TOO_LARGE",
      "The image dimensions are too large.",
    );
  }

  return {
    checksumSha256: createHash("sha256").update(buffer).digest("hex").toUpperCase(),
    height,
    mimeType,
    sizeBytes: buffer.length,
    width,
  };
}

export function inspectOnboardingV2AuthorImage(
  buffer: Buffer,
  declaredMimeType: string,
): OnboardingV2AuthorImageInspection {
  if (buffer.length > ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES) {
    throw new OnboardingV2AuthorImageValidationError(
      "ONBOARDING_V2_AUTHOR_IMAGE_TOO_LARGE",
      "Author image must be 1 MB or smaller.",
      413,
    );
  }
  return inspectImageUpload(buffer, declaredMimeType, {
    maxBytes: ONBOARDING_V2_AUTHOR_IMAGE_MAX_BYTES,
    minDimension: ONBOARDING_V2_AUTHOR_IMAGE_MIN_DIMENSION,
    maxDimension: ONBOARDING_V2_AUTHOR_IMAGE_MAX_DIMENSION,
    maxPixels: ONBOARDING_V2_AUTHOR_IMAGE_MAX_PIXELS,
  });
}

export function safeOnboardingV2AuthorImageName(
  originalName: string,
  fallback = "author-image",
): string {
  const cleaned = basename(originalName)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return cleaned || fallback;
}

export async function uploadOnboardingV2AuthorImage(input: {
  buffer: Buffer;
  declaredMimeType: string;
  quickBusinessId: string;
  userId: string;
}): Promise<OnboardingV2AuthorImageInspection & ImageUploadReceipt> {
  const inspection = inspectOnboardingV2AuthorImage(
    input.buffer,
    input.declaredMimeType,
  );
  const receipt = await uploadImageBufferWithMetadata(
    input.buffer,
    inspection.mimeType,
    {
      folder: `onboarding-v2/author-images/${input.userId}/${input.quickBusinessId}`,
      publicId: `author-${inspection.checksumSha256.toLowerCase().slice(0, 32)}`,
    },
  );
  return { ...inspection, ...receipt };
}
