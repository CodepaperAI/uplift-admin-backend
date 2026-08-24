import {
  type BunnyImageUploadReceipt,
  uploadImageBufferToBunny,
} from "./bunny-storage";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DATA_IMAGE_PATTERN = /^data:([^;,]+);base64,([\s\S]+)$/i;

function normalizedMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function assertImageBuffer(buffer: Buffer): void {
  if (buffer.length === 0) {
    throw new Error("Image upload requires a non-empty image");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Image upload exceeds the 25 MB limit");
  }
}

export type ImageUploadReceipt = BunnyImageUploadReceipt;

/**
 * The single write path for image persistence. Existing Cloudinary URLs are
 * still readable, but every new image is written to Bunny and failures never
 * fall back to another provider.
 */
export async function uploadImageBufferWithMetadata(
  buffer: Buffer,
  mimeType: string,
  options: {
    folder?: string;
    publicId?: string;
  } = {},
): Promise<ImageUploadReceipt> {
  assertImageBuffer(buffer);
  return uploadImageBufferToBunny(buffer, normalizedMimeType(mimeType), options);
}

export async function uploadImageBuffer(
  buffer: Buffer,
  mimeType: string,
  folder = "images",
): Promise<string> {
  const receipt = await uploadImageBufferWithMetadata(buffer, mimeType, {
    folder,
  });
  return receipt.url;
}

export async function uploadBase64Image(
  source: string,
  folder = "ai-images",
): Promise<string> {
  const match = DATA_IMAGE_PATTERN.exec(source.trim());
  if (!match) {
    throw new Error("Image source must be a base64 data URL");
  }
  const mimeType = normalizedMimeType(match[1] ?? "");
  const buffer = Buffer.from((match[2] ?? "").replace(/\s+/g, ""), "base64");
  const receipt = await uploadImageBufferWithMetadata(buffer, mimeType, {
    folder,
  });
  return receipt.url;
}
