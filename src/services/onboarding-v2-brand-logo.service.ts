import { createHash } from "node:crypto";
import sharp from "sharp";

import {
  type ImageUploadReceipt,
  uploadImageBufferWithMetadata,
} from "../lib/image-storage";
import { fetchPublicResource } from "./social-creative/safe-fetch";

export const ONBOARDING_V2_BRAND_LOGO_MAX_BYTES = 8 * 1024 * 1024;
export const ONBOARDING_V2_BRAND_LOGO_MAX_DIMENSION = 8_192;
export const ONBOARDING_V2_BRAND_LOGO_MAX_OUTPUT_DIMENSION = 2_048;
export const ONBOARDING_V2_BRAND_LOGO_MAX_PIXELS = 40_000_000;

const FORMAT_MIME_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};
const ACCEPTED_MIME_TYPES = new Set(Object.values(FORMAT_MIME_TYPES));

function bunnyCdnHostnames(): Set<string> {
  const hostnames = new Set(["uplift-ai-images.b-cdn.net"]);
  const configured = process.env.BUNNY_CDN_BASE_URL?.trim();
  if (configured) {
    try {
      hostnames.add(new URL(configured).hostname.toLowerCase());
    } catch {
      // Upload configuration validation reports malformed URLs separately.
    }
  }
  return hostnames;
}

export function isCanonicalBunnyBrandLogoUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      bunnyCdnHostnames().has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export class OnboardingV2BrandLogoValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "OnboardingV2BrandLogoValidationError";
  }
}

export type NormalizedOnboardingV2BrandLogo = {
  buffer: Buffer;
  canonicalMimeType: "image/png";
  checksumSha256: string;
  height: number;
  sizeBytes: number;
  sourceMimeType: string;
  width: number;
};

export type CanonicalOnboardingV2BrandLogo = ImageUploadReceipt & {
  canonicalMimeType: "image/png";
  height: number;
  sizeBytes: number;
  sourceMimeType: string;
  sourceUrl: string | null;
  width: number;
};

type BrandLogoDependencies = {
  fetchResource?: typeof fetchPublicResource;
  upload?: typeof uploadImageBufferWithMetadata;
};

function normalizedMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function assertSafeSvg(buffer: Buffer): void {
  const source = buffer.toString("utf8");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source)) {
    throw new OnboardingV2BrandLogoValidationError(
      "ONBOARDING_V2_BRAND_LOGO_SIGNATURE_INVALID",
      "The logo contents do not match its declared file type.",
    );
  }

  // SVG is active XML. Only accept self-contained vector markup before
  // rasterizing it; scripts, entities, embedded documents and external
  // references must never reach the image decoder.
  const unsafeMarkup =
    /<!doctype|<!entity|<script\b|<foreignObject\b|@import\b|<image\b|\b(?:href|xlink:href)\s*=\s*["'](?!#)|\burl\(\s*["']?(?!#)/i;
  if (unsafeMarkup.test(source)) {
    throw new OnboardingV2BrandLogoValidationError(
      "ONBOARDING_V2_BRAND_LOGO_SVG_UNSAFE",
      "Choose a self-contained SVG without scripts or external resources.",
    );
  }
}

function validationError(error: unknown): OnboardingV2BrandLogoValidationError {
  if (error instanceof OnboardingV2BrandLogoValidationError) return error;
  return new OnboardingV2BrandLogoValidationError(
    "ONBOARDING_V2_BRAND_LOGO_INVALID",
    "The selected logo could not be decoded safely.",
  );
}

export async function normalizeOnboardingV2BrandLogo(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<NormalizedOnboardingV2BrandLogo> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new OnboardingV2BrandLogoValidationError(
      "ONBOARDING_V2_BRAND_LOGO_EMPTY",
      "Choose a non-empty logo image.",
    );
  }
  if (buffer.length > ONBOARDING_V2_BRAND_LOGO_MAX_BYTES) {
    throw new OnboardingV2BrandLogoValidationError(
      "ONBOARDING_V2_BRAND_LOGO_TOO_LARGE",
      "Choose a logo that is 8 MB or smaller.",
      413,
    );
  }

  const mimeType = normalizedMimeType(declaredMimeType);
  if (!ACCEPTED_MIME_TYPES.has(mimeType)) {
    throw new OnboardingV2BrandLogoValidationError(
      "ONBOARDING_V2_BRAND_LOGO_TYPE_INVALID",
      "Choose a JPEG, PNG, WebP, GIF, or SVG logo.",
    );
  }
  if (mimeType === "image/svg+xml") assertSafeSvg(buffer);

  try {
    const input = sharp(buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: ONBOARDING_V2_BRAND_LOGO_MAX_PIXELS,
      pages: 1,
    });
    const metadata = await input.metadata();
    const detectedMimeType = metadata.format
      ? FORMAT_MIME_TYPES[metadata.format]
      : undefined;
    if (!detectedMimeType || detectedMimeType !== mimeType) {
      throw new OnboardingV2BrandLogoValidationError(
        "ONBOARDING_V2_BRAND_LOGO_SIGNATURE_INVALID",
        "The logo contents do not match its declared file type.",
      );
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      width < 1 ||
      height < 1 ||
      width > ONBOARDING_V2_BRAND_LOGO_MAX_DIMENSION ||
      height > ONBOARDING_V2_BRAND_LOGO_MAX_DIMENSION ||
      width * height > ONBOARDING_V2_BRAND_LOGO_MAX_PIXELS
    ) {
      throw new OnboardingV2BrandLogoValidationError(
        "ONBOARDING_V2_BRAND_LOGO_DIMENSIONS_INVALID",
        "Choose a logo no larger than 8192 × 8192 pixels or 40 megapixels.",
      );
    }

    const { data, info } = await sharp(buffer, {
      animated: false,
      failOn: "warning",
      limitInputPixels: ONBOARDING_V2_BRAND_LOGO_MAX_PIXELS,
      pages: 1,
    })
      .rotate()
      .resize({
        fit: "inside",
        height: ONBOARDING_V2_BRAND_LOGO_MAX_OUTPUT_DIMENSION,
        width: ONBOARDING_V2_BRAND_LOGO_MAX_OUTPUT_DIMENSION,
        withoutEnlargement: true,
      })
      .png({ adaptiveFiltering: true, compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    const checksumSha256 = createHash("sha256")
      .update(data)
      .digest("hex")
      .toUpperCase();

    return {
      buffer: data,
      canonicalMimeType: "image/png",
      checksumSha256,
      height: info.height,
      sizeBytes: data.length,
      sourceMimeType: mimeType,
      width: info.width,
    };
  } catch (error) {
    throw validationError(error);
  }
}

async function persistNormalizedBrandLogo(
  normalized: NormalizedOnboardingV2BrandLogo,
  input: {
    folder?: string;
    quickBusinessId: string;
    sourceUrl: string | null;
    userId: string;
  },
  dependencies: BrandLogoDependencies = {},
): Promise<CanonicalOnboardingV2BrandLogo> {
  const upload = dependencies.upload ?? uploadImageBufferWithMetadata;
  const receipt = await upload(normalized.buffer, normalized.canonicalMimeType, {
    folder:
      input.folder ??
      `onboarding-v2/brand-logos/${input.userId}/${input.quickBusinessId}`,
    publicId: `logo-${normalized.checksumSha256.toLowerCase().slice(0, 32)}`,
  });
  return {
    ...receipt,
    canonicalMimeType: normalized.canonicalMimeType,
    height: normalized.height,
    sizeBytes: normalized.sizeBytes,
    sourceMimeType: normalized.sourceMimeType,
    sourceUrl: input.sourceUrl,
    width: normalized.width,
  };
}

export async function uploadOnboardingV2BrandLogo(
  input: {
    buffer: Buffer;
    declaredMimeType: string;
    quickBusinessId: string;
    userId: string;
  },
  dependencies: BrandLogoDependencies = {},
): Promise<CanonicalOnboardingV2BrandLogo> {
  const normalized = await normalizeOnboardingV2BrandLogo(
    input.buffer,
    input.declaredMimeType,
  );
  return persistNormalizedBrandLogo(
    normalized,
    {
      quickBusinessId: input.quickBusinessId,
      sourceUrl: null,
      userId: input.userId,
    },
    dependencies,
  );
}

/**
 * Stores a logo explicitly selected by an existing Business owner. The
 * normalization path is shared with onboarding so every downstream consumer
 * receives the same bounded, canonical PNG instead of untrusted source bytes.
 */
export async function uploadBusinessBrandLogo(
  input: {
    buffer: Buffer;
    businessId: string;
    declaredMimeType: string;
    userId: string;
  },
  dependencies: BrandLogoDependencies = {},
): Promise<CanonicalOnboardingV2BrandLogo> {
  const normalized = await normalizeOnboardingV2BrandLogo(
    input.buffer,
    input.declaredMimeType,
  );
  return persistNormalizedBrandLogo(
    normalized,
    {
      folder: `businesses/${input.userId}/${input.businessId}/brand-logos`,
      quickBusinessId: input.businessId,
      sourceUrl: null,
      userId: input.userId,
    },
    dependencies,
  );
}

export async function canonicalizeRemoteOnboardingV2BrandLogo(
  input: {
    logoUrl: string;
    quickBusinessId: string;
    userId: string;
  },
  dependencies: BrandLogoDependencies = {},
): Promise<CanonicalOnboardingV2BrandLogo> {
  let resource: Awaited<ReturnType<typeof fetchPublicResource>>;
  try {
    resource = await (dependencies.fetchResource ?? fetchPublicResource)(
      input.logoUrl,
      {
        allowedContentTypes: ["image/"],
        maxBytes: ONBOARDING_V2_BRAND_LOGO_MAX_BYTES,
      },
    );
  } catch (error) {
    throw new OnboardingV2BrandLogoValidationError(
      "ONBOARDING_V2_BRAND_LOGO_FETCH_FAILED",
      "The logo URL could not be downloaded safely. Upload the logo or choose another URL.",
      422,
    );
  }
  const normalized = await normalizeOnboardingV2BrandLogo(
    resource.buffer,
    resource.contentType,
  );
  return persistNormalizedBrandLogo(
    normalized,
    {
      quickBusinessId: input.quickBusinessId,
      sourceUrl: resource.finalUrl,
      userId: input.userId,
    },
    dependencies,
  );
}

/**
 * Repairs legacy daily-social logo references without changing the onboarding
 * creative path. It deliberately shares onboarding's validation and PNG
 * normalization, while storing the result in a daily-social namespace.
 */
export async function canonicalizeRemoteDailySocialBrandLogo(
  input: {
    businessId: string;
    logoUrl: string;
    userId: string;
  },
  dependencies: BrandLogoDependencies = {},
): Promise<CanonicalOnboardingV2BrandLogo> {
  let resource: Awaited<ReturnType<typeof fetchPublicResource>>;
  try {
    resource = await (dependencies.fetchResource ?? fetchPublicResource)(
      input.logoUrl,
      {
        allowedContentTypes: ["image/"],
        maxBytes: ONBOARDING_V2_BRAND_LOGO_MAX_BYTES,
      },
    );
  } catch {
    throw new OnboardingV2BrandLogoValidationError(
      "DAILY_SOCIAL_BRAND_LOGO_FETCH_FAILED",
      "The approved brand logo could not be downloaded safely.",
      422,
    );
  }
  const normalized = await normalizeOnboardingV2BrandLogo(
    resource.buffer,
    resource.contentType,
  );
  return persistNormalizedBrandLogo(
    normalized,
    {
      folder: `social-creatives/brand-logos/${input.userId}/${input.businessId}`,
      quickBusinessId: input.businessId,
      sourceUrl: resource.finalUrl,
      userId: input.userId,
    },
    dependencies,
  );
}

/**
 * Stores a detected legacy/business logo in the durable owner-scoped Bunny
 * namespace used by every downstream image pipeline.
 */
export async function canonicalizeRemoteBusinessBrandLogo(
  input: {
    businessId: string;
    logoUrl: string;
    userId: string;
  },
  dependencies: BrandLogoDependencies = {},
): Promise<CanonicalOnboardingV2BrandLogo> {
  let resource: Awaited<ReturnType<typeof fetchPublicResource>>;
  try {
    resource = await (dependencies.fetchResource ?? fetchPublicResource)(
      input.logoUrl,
      {
        allowedContentTypes: ["image/"],
        maxBytes: ONBOARDING_V2_BRAND_LOGO_MAX_BYTES,
      },
    );
  } catch {
    throw new OnboardingV2BrandLogoValidationError(
      "BUSINESS_BRAND_LOGO_FETCH_FAILED",
      "The detected business logo could not be downloaded safely.",
      422,
    );
  }
  const normalized = await normalizeOnboardingV2BrandLogo(
    resource.buffer,
    resource.contentType,
  );
  return persistNormalizedBrandLogo(
    normalized,
    {
      folder: `businesses/${input.userId}/${input.businessId}/brand-logos`,
      quickBusinessId: input.businessId,
      sourceUrl: resource.finalUrl,
      userId: input.userId,
    },
    dependencies,
  );
}

export function serializeOnboardingV2BrandLogo(
  logo: CanonicalOnboardingV2BrandLogo,
  source: "confirmed_url" | "user_upload",
) {
  return {
    provider: logo.provider,
    url: logo.url,
    objectKey: logo.objectKey,
    checksumSha256: logo.checksumSha256,
    source,
    sourceUrl: logo.sourceUrl,
    sourceMimeType: logo.sourceMimeType,
    canonicalMimeType: logo.canonicalMimeType,
    width: logo.width,
    height: logo.height,
    sizeBytes: logo.sizeBytes,
    updatedAt: new Date().toISOString(),
  };
}
