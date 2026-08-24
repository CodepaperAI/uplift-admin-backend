import { uploadImageBufferWithMetadata } from "./image-storage";

export type SocialImageStorageProvider = "bunny" | "cloudinary";

export type SocialImageUploadReceipt = {
  account?: "primary" | "fallback";
  bytes: number;
  checksumSha256?: string;
  format: string | null;
  objectKey: string;
  provider: SocialImageStorageProvider;
  publicId?: string;
  storageZone?: string;
  url: string;
};

export function getSocialImageStorageProvider(
  env: Record<string, string | undefined> = process.env,
): SocialImageStorageProvider {
  const provider = env.SOCIAL_IMAGE_STORAGE_PROVIDER?.trim().toLowerCase();
  // Bunny is the only image write provider. Keep the legacy union in receipt
  // types so persisted Cloudinary checkpoints remain recoverable/readable.
  if (!provider || provider === "bunny") return "bunny";
  throw new Error(
    `Unsupported SOCIAL_IMAGE_STORAGE_PROVIDER: ${provider}. Bunny is required`,
  );
}

export async function uploadSocialImageBufferWithMetadata(
  buffer: Buffer,
  mimeType: string,
  options: { folder: string; publicId: string },
): Promise<SocialImageUploadReceipt> {
  getSocialImageStorageProvider();
  return uploadImageBufferWithMetadata(buffer, mimeType, {
    folder: options.folder,
    publicId: options.publicId,
  });
}
