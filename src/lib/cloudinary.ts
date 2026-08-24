const CLOUDINARY_UPLOAD_NEEDLE = "/image/upload/";

function isCloudinaryUploadUrl(url: string): boolean {
  return (
    Boolean(url) &&
    url.includes("res.cloudinary.com/") &&
    url.includes(CLOUDINARY_UPLOAD_NEEDLE)
  );
}

function looksLikeTransformationSegment(segment: string): boolean {
  if (!segment) return false;
  return segment.includes(",") || /^[a-z]{1,4}_[^/]+,?$/i.test(segment);
}

/**
 * Normalize a Cloudinary delivery URL so:
 * - malformed transform segments like `f_auto,q_auto,/` are removed
 * - transformed delivery URLs are collapsed back to the raw upload URL
 * - existing stored transformed URLs still render correctly across the app
 */
export function normalizeCloudinaryImageUrl(url: string, width = 1280): string {
  if (!isCloudinaryUploadUrl(url)) {
    return url;
  }

  const idx = url.indexOf(CLOUDINARY_UPLOAD_NEEDLE);
  if (idx === -1) return url;

  const prefix = url.slice(0, idx + CLOUDINARY_UPLOAD_NEEDLE.length);
  const afterUpload = url.slice(idx + CLOUDINARY_UPLOAD_NEEDLE.length);
  if (!afterUpload) {
    return url;
  }

  const slashIndex = afterUpload.indexOf("/");
  const firstSegment =
    slashIndex === -1 ? afterUpload : afterUpload.slice(0, slashIndex);
  const remainder =
    slashIndex === -1 ? "" : afterUpload.slice(slashIndex + 1);

  if (looksLikeTransformationSegment(firstSegment)) {
    return remainder ? `${prefix}${remainder}` : prefix.slice(0, -1);
  }

  return url;
}

/**
 * Keep this helper for compatibility with older call sites, but return the raw
 * Cloudinary upload URL because transformed delivery URLs are failing for this
 * deployment/account.
 */
export function toResponsiveCloudinaryUrl(url: string, width = 1280): string {
  return normalizeCloudinaryImageUrl(url, width);
}

/**
 * Legacy read compatibility for existing Cloudinary records. New image writes
 * are handled exclusively by image-storage.ts and Bunny Storage.
 */
export function buildResponsiveImageManifest(url: string): {
  src: string;
  srcSet: string;
  widths: number[];
} {
  const normalizedUrl = normalizeCloudinaryImageUrl(url);
  return {
    src: normalizedUrl,
    srcSet: `${normalizedUrl} 1280w`,
    widths: [1280],
  };
}
