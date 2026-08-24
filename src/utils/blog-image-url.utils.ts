import { normalizeCloudinaryImageUrl } from "../lib/cloudinary";

const IMAGE_URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/i;

export interface BlogImageSanitizationResult {
  featuredMediaChanged: boolean;
  removedInvalidImages: number;
  normalizedImageSources: number;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isPlaceholderImageUrl(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    lower.length === 0 ||
    lower === "url" ||
    lower === "image_url" ||
    lower === "imageurl" ||
    lower === "[object object]" ||
    lower.includes("example.com/image") ||
    /^url\d*$/.test(lower)
  );
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function trimTrailingJsonPunctuation(value: string): string {
  return value.replace(/[),.;]+$/g, "");
}

export function extractImageUrl(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        const extracted = extractImageUrl(item);
        if (extracted) return extracted;
      }
      return null;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["imageUrl", "url", "secure_url", "src"]) {
      const extracted = extractImageUrl(record[key]);
      if (extracted) return extracted;
    }
    return extractImageUrl(record.images);
  }

  if (typeof value !== "string") return null;

  const decoded = stripWrappingQuotes(decodeHtmlEntities(value));
  if (isPlaceholderImageUrl(decoded)) return null;

  if (isPublicHttpUrl(decoded)) {
    return normalizeCloudinaryImageUrl(decoded);
  }

  if (decoded.startsWith("{") || decoded.startsWith("[")) {
    try {
      return extractImageUrl(JSON.parse(decoded));
    } catch {
      // Continue to regex extraction below; model output is sometimes JSON-ish.
    }
  }

  const match = decoded.match(IMAGE_URL_PATTERN);
  if (!match?.[0]) return null;

  const candidate = trimTrailingJsonPunctuation(match[0]);
  return isPublicHttpUrl(candidate) && !isPlaceholderImageUrl(candidate)
    ? normalizeCloudinaryImageUrl(candidate)
    : null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function sanitizeBlogContentImageSources(content: string): {
  content: string;
  removedInvalidImages: number;
  normalizedImageSources: number;
} {
  let removedInvalidImages = 0;
  let normalizedImageSources = 0;

  const sanitized = content.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (!srcMatch) {
      removedInvalidImages += 1;
      return "";
    }

    const quote = srcMatch[1] ?? '"';
    const rawSrc = srcMatch[2] ?? "";
    const normalizedSrc = extractImageUrl(rawSrc);
    if (!normalizedSrc) {
      removedInvalidImages += 1;
      return "";
    }

    if (normalizedSrc === rawSrc.trim()) {
      return tag;
    }

    normalizedImageSources += 1;
    return tag.replace(srcMatch[0], `src=${quote}${escapeHtmlAttribute(normalizedSrc)}${quote}`);
  });

  return {
    content: sanitized,
    removedInvalidImages,
    normalizedImageSources,
  };
}

export function sanitizeBlogImagePayload(
  payload: { featured_media?: string; content?: string },
): BlogImageSanitizationResult {
  let featuredMediaChanged = false;
  let removedInvalidImages = 0;
  let normalizedImageSources = 0;

  if (payload.featured_media !== undefined) {
    const original = payload.featured_media;
    const normalized = extractImageUrl(original) ?? "";
    if (normalized !== original) {
      payload.featured_media = normalized;
      featuredMediaChanged = true;
    }
  }

  if (payload.content !== undefined) {
    const sanitized = sanitizeBlogContentImageSources(payload.content);
    payload.content = sanitized.content;
    removedInvalidImages = sanitized.removedInvalidImages;
    normalizedImageSources = sanitized.normalizedImageSources;
  }

  return {
    featuredMediaChanged,
    removedInvalidImages,
    normalizedImageSources,
  };
}
