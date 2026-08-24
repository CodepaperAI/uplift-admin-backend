import { describe, expect, test } from "bun:test";

import { socialPromotionSettingsSchema } from "../controllers/social-publishing.controller";
import {
  extractSocialPromotionDocument,
  localDateInTimeZone,
  resolveSocialPromotionForInstant,
  SocialPromotionValidationError,
  uploadSocialPromotionImage,
} from "../services/social-promotion.service";

function png(width = 800, height = 800): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    buffer,
  );
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

const activePromotion = {
  enabled: true,
  title: "August care package",
  information: "Book the approved care package during the listed dates.",
  preferredContent: "Ask about the August package.",
  startsOn: "2026-08-19",
  endsOn: "2026-08-23",
  imageUrl: "https://uplift-ai-images.b-cdn.net/promotion.png",
  documentName: "offer.pdf",
  documentText: "The package includes the exact services described here.",
};

describe("social promotion settings and assets", () => {
  test("requires complete facts and a valid bounded duration only when enabled", () => {
    expect(
      socialPromotionSettingsSchema.safeParse({
        businessId: "00000000-0000-4000-8000-000000000001",
        enabled: false,
        title: null,
        information: null,
        preferredContent: null,
        startsOn: null,
        endsOn: null,
      }).success,
    ).toBe(true);
    expect(
      socialPromotionSettingsSchema.safeParse({
        businessId: "00000000-0000-4000-8000-000000000001",
        enabled: true,
        title: "",
        information: "",
        preferredContent: null,
        startsOn: "2026-08-25",
        endsOn: "2026-08-20",
      }).success,
    ).toBe(false);
    expect(
      socialPromotionSettingsSchema.parse({
        businessId: "00000000-0000-4000-8000-000000000001",
        ...activePromotion,
      }),
    ).toMatchObject({
      enabled: true,
      title: "August care package",
      startsOn: "2026-08-19",
      endsOn: "2026-08-23",
    });
  });

  test("resolves whole promotion days in the scheduled business timezone", () => {
    const instant = new Date("2026-08-20T03:30:00.000Z");
    expect(localDateInTimeZone(instant, "America/Toronto")).toBe("2026-08-19");
    expect(localDateInTimeZone(instant, "Asia/Kolkata")).toBe("2026-08-20");
    expect(
      resolveSocialPromotionForInstant({
        promotion: activePromotion,
        scheduledFor: instant,
        timeZone: "America/Toronto",
      }),
    ).toMatchObject({ title: "August care package", enabled: true });
    expect(
      resolveSocialPromotionForInstant({
        promotion: activePromotion,
        scheduledFor: new Date("2026-08-24T14:00:00.000Z"),
        timeZone: "America/Toronto",
      }),
    ).toBeNull();
    expect(
      resolveSocialPromotionForInstant({
        promotion: { ...activePromotion, enabled: false },
        scheduledFor: instant,
        timeZone: "America/Toronto",
      }),
    ).toBeNull();
  });

  test("extracts bounded factual text and rejects spoofed documents", async () => {
    const text = await extractSocialPromotionDocument({
      buffer: Buffer.from(
        "Offer facts\n\nThe package includes two approved services for August.",
      ),
      declaredMimeType: "text/plain",
      originalName: "../August offer.txt",
    });
    expect(text).toMatchObject({
      name: "August offer.txt",
      mimeType: "text/plain",
    });
    expect(text.text).toContain("two approved services");
    expect(text.checksumSha256).toMatch(/^[A-F0-9]{64}$/);

    const pdf = await extractSocialPromotionDocument(
      {
        buffer: Buffer.from("%PDF-synthetic"),
        declaredMimeType: "application/pdf",
        originalName: "details.pdf",
      },
      {
        parsePdf: async () =>
          "Synthetic PDF promotion facts that are long enough to use safely.",
      },
    );
    expect(pdf.text).toContain("Synthetic PDF promotion facts");

    await expect(
      extractSocialPromotionDocument({
        buffer: Buffer.from("not a PDF"),
        declaredMimeType: "application/pdf",
        originalName: "spoofed.pdf",
      }),
    ).rejects.toMatchObject({
      code: "SOCIAL_PROMOTION_DOCUMENT_SIGNATURE_INVALID",
    });
  });

  test("validates image bytes and stores an optional deterministic reference", async () => {
    let uploadOptions: Record<string, unknown> | undefined;
    const result = await uploadSocialPromotionImage(
      {
        buffer: png(),
        businessId: "business-1",
        declaredMimeType: "image/png",
        originalName: "../Weekend Promo.png",
      },
      {
        upload: async (_buffer, _mimeType, options) => {
          uploadOptions = options;
          return {
            bytes: 33,
            checksumSha256: "A".repeat(64),
            format: "png",
            objectKey: "social-promotions/business-1/reference.png",
            provider: "bunny",
            storageZone: "test",
            url: "https://uplift-ai-images.b-cdn.net/reference.png",
          };
        },
      },
    );
    expect(result).toMatchObject({
      name: "Weekend Promo.png",
      mimeType: "image/png",
      width: 800,
      height: 800,
      url: "https://uplift-ai-images.b-cdn.net/reference.png",
    });
    expect(uploadOptions?.folder).toBe("social-promotions/business-1");
    expect(String(uploadOptions?.publicId)).toStartWith("reference-");

    await uploadSocialPromotionImage(
      {
        buffer: png(),
        businessId: "business-1",
        declaredMimeType: "image/png",
        originalName: "Always On.png",
        scope: "always",
      },
      {
        upload: async (_buffer, _mimeType, options) => {
          uploadOptions = options;
          return {
            bytes: 33,
            checksumSha256: "A".repeat(64),
            format: "png",
            objectKey: "social-references/business-1/always/reference.png",
            provider: "bunny",
            storageZone: "test",
            url: "https://uplift-ai-images.b-cdn.net/reference.png",
          };
        },
      },
    );
    expect(uploadOptions?.folder).toBe("social-references/business-1/always");

    await expect(
      uploadSocialPromotionImage({
        buffer: Buffer.from("<svg><script/></svg>"),
        businessId: "business-1",
        declaredMimeType: "image/png",
        originalName: "spoofed.png",
      }),
    ).rejects.toBeInstanceOf(SocialPromotionValidationError);
  });
});
