import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import {
  canonicalizeRemoteBusinessBrandLogo,
  canonicalizeRemoteDailySocialBrandLogo,
  isCanonicalBunnyBrandLogoUrl,
  normalizeOnboardingV2BrandLogo,
  OnboardingV2BrandLogoValidationError,
  uploadBusinessBrandLogo,
  uploadOnboardingV2BrandLogo,
} from "../services/onboarding-v2-brand-logo.service";

describe("onboarding-v2 canonical brand logos", () => {
  test("rasterizes a basic VP8 WebP into a bounded canonical PNG", async () => {
    const webp = await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: { r: 33, g: 22, b: 11 },
      },
    })
      .webp({ lossless: false })
      .toBuffer();
    expect(webp.toString("ascii", 12, 16)).toBe("VP8 ");

    const normalized = await normalizeOnboardingV2BrandLogo(
      webp,
      "image/webp",
    );
    expect(normalized.canonicalMimeType).toBe("image/png");
    expect(normalized.buffer.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(normalized).toMatchObject({
      width: 320,
      height: 180,
      sourceMimeType: "image/webp",
    });
  });

  test("stores a deterministic PNG object and never uploads the source bytes", async () => {
    const source = await sharp({
      create: {
        width: 96,
        height: 96,
        channels: 3,
        background: "#6d5df6",
      },
    })
      .gif()
      .toBuffer();
    let uploaded: { buffer: Buffer; mimeType: string; options: any } | null = null;

    const result = await uploadOnboardingV2BrandLogo(
      {
        buffer: source,
        declaredMimeType: "image/gif",
        quickBusinessId: "quick-1",
        userId: "user-1",
      },
      {
        upload: async (buffer, mimeType, options) => {
          if (!options?.folder || !options.publicId) {
            throw new Error("Expected deterministic upload options");
          }
          uploaded = { buffer, mimeType, options };
          const checksumSha256 = createHash("sha256")
            .update(buffer)
            .digest("hex")
            .toUpperCase();
          return {
            bytes: buffer.length,
            checksumSha256,
            format: "png",
            objectKey: `${options.folder}/${options.publicId}.png`,
            provider: "bunny" as const,
            storageZone: "test",
            url: `https://cdn.example/${options.publicId}.png`,
          };
        },
      },
    );

    expect(uploaded).not.toBeNull();
    expect(uploaded!.mimeType).toBe("image/png");
    expect(uploaded!.buffer).not.toEqual(source);
    expect(uploaded!.options.folder).toBe(
      "onboarding-v2/brand-logos/user-1/quick-1",
    );
    expect(result).toMatchObject({
      canonicalMimeType: "image/png",
      sourceMimeType: "image/gif",
      provider: "bunny",
      sourceUrl: null,
    });
  });

  test("stores repaired daily-social SVG logos as canonical Bunny PNGs", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#ef3124"/></svg>',
    );
    let uploadOptions: { folder?: string; publicId?: string } | undefined;

    const result = await canonicalizeRemoteDailySocialBrandLogo(
      {
        businessId: "business-1",
        logoUrl: "https://brand.example/logo.svg",
        userId: "user-1",
      },
      {
        fetchResource: async () => ({
          buffer: svg,
          contentType: "image/svg+xml",
          finalUrl: "https://brand.example/logo.svg",
        }),
        upload: async (buffer, mimeType, options) => {
          if (!options?.folder || !options.publicId) {
            throw new Error("Expected deterministic upload options");
          }
          uploadOptions = options;
          return {
            bytes: buffer.length,
            checksumSha256: createHash("sha256")
              .update(buffer)
              .digest("hex")
              .toUpperCase(),
            format: "png",
            objectKey: `${options.folder}/${options.publicId}.png`,
            provider: "bunny" as const,
            storageZone: "test",
            url: "https://cdn.example/daily-logo.png",
          };
        },
      },
    );

    expect(uploadOptions?.folder).toBe(
      "social-creatives/brand-logos/user-1/business-1",
    );
    expect(result).toMatchObject({
      canonicalMimeType: "image/png",
      sourceMimeType: "image/svg+xml",
      sourceUrl: "https://brand.example/logo.svg",
      url: "https://cdn.example/daily-logo.png",
    });
  });

  test("stores refreshed business logos in an owner-scoped canonical namespace", async () => {
    const png = await sharp({
      create: {
        width: 240,
        height: 80,
        channels: 4,
        background: "#123456",
      },
    })
      .png()
      .toBuffer();
    let folder: string | undefined;

    const result = await canonicalizeRemoteBusinessBrandLogo(
      {
        businessId: "business-1",
        logoUrl: "https://brand.example/logo.png",
        userId: "user-1",
      },
      {
        fetchResource: async () => ({
          buffer: png,
          contentType: "image/png",
          finalUrl: "https://brand.example/logo.png",
        }),
        upload: async (buffer, _mimeType, options) => {
          folder = options?.folder;
          return {
            bytes: buffer.length,
            checksumSha256: createHash("sha256")
              .update(buffer)
              .digest("hex")
              .toUpperCase(),
            format: "png",
            objectKey: `${options?.folder}/${options?.publicId}.png`,
            provider: "bunny" as const,
            storageZone: "test",
            url: "https://uplift-ai-images.b-cdn.net/business-logo.png",
          };
        },
      },
    );

    expect(folder).toBe("businesses/user-1/business-1/brand-logos");
    expect(result.url).toBe(
      "https://uplift-ai-images.b-cdn.net/business-logo.png",
    );
    expect(isCanonicalBunnyBrandLogoUrl(result.url)).toBe(true);
    expect(isCanonicalBunnyBrandLogoUrl("https://example.com/logo.png")).toBe(
      false,
    );
  });

  test("stores a user-uploaded Business logo in the downstream brand namespace", async () => {
    const source = await sharp({
      create: {
        width: 360,
        height: 120,
        channels: 4,
        background: "#6d5df6",
      },
    })
      .webp()
      .toBuffer();
    let folder: string | undefined;

    const result = await uploadBusinessBrandLogo(
      {
        buffer: source,
        businessId: "business-1",
        declaredMimeType: "image/webp",
        userId: "user-1",
      },
      {
        upload: async (buffer, mimeType, options) => {
          folder = options?.folder;
          return {
            bytes: buffer.length,
            checksumSha256: createHash("sha256")
              .update(buffer)
              .digest("hex")
              .toUpperCase(),
            format: "png",
            objectKey: `${options?.folder}/${options?.publicId}.png`,
            provider: "bunny" as const,
            storageZone: "test",
            url: "https://uplift-ai-images.b-cdn.net/manual-logo.png",
          };
        },
      },
    );

    expect(folder).toBe("businesses/user-1/business-1/brand-logos");
    expect(result).toMatchObject({
      canonicalMimeType: "image/png",
      sourceMimeType: "image/webp",
      sourceUrl: null,
      width: 360,
      height: 120,
    });
  });

  test("rejects SVG scripts and external references before decoding", async () => {
    const unsafe = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(
      normalizeOnboardingV2BrandLogo(unsafe, "image/svg+xml"),
    ).rejects.toMatchObject({
      name: "OnboardingV2BrandLogoValidationError",
      code: "ONBOARDING_V2_BRAND_LOGO_SVG_UNSAFE",
    } satisfies Partial<OnboardingV2BrandLogoValidationError>);
  });
});
