import { createHash } from "node:crypto";
import { basename } from "node:path";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { uploadImageBufferWithMetadata } from "../lib/image-storage";
import {
  inspectImageUpload,
  OnboardingV2AuthorImageValidationError,
} from "./onboarding-v2-author-image.service";
import type {
  SocialCreativePromotion,
  SocialCreativePromotionInput,
} from "./social-creative/types";

export const SOCIAL_PROMOTION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SOCIAL_PROMOTION_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const SOCIAL_PROMOTION_DOCUMENT_TEXT_MAX_CHARACTERS = 12_000;
export const SOCIAL_REFERENCE_IMAGE_MAX_PER_SCOPE = 3;

export type SocialReferenceImageScope = "always" | "promotion";

export const SOCIAL_PROMOTION_DOCUMENT_MIME_TYPES = Object.freeze({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "text/markdown": "md",
  "text/plain": "txt",
} as const);

type PromotionDocumentMimeType =
  keyof typeof SOCIAL_PROMOTION_DOCUMENT_MIME_TYPES;

export class SocialPromotionValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "SocialPromotionValidationError";
  }
}

function normalizedMimeType(value: unknown): string {
  const mimeType = String(value ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function safeSocialPromotionFileName(
  value: unknown,
  fallback: string,
): string {
  const name = basename(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return name || fallback;
}

function boundedPromotionText(value: unknown, maximumLength: number): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= maximumLength) return normalized;
  const candidate = normalized.slice(0, maximumLength - 1).trimEnd();
  const boundary = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"));
  return `${candidate.slice(0, boundary >= maximumLength * 0.7 ? boundary : candidate.length).trimEnd()}…`;
}

function assertNonEmptyFile(buffer: Buffer, maximumBytes: number, label: string) {
  const codeLabel = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new SocialPromotionValidationError(
      `SOCIAL_${codeLabel}_EMPTY`,
      `Choose a non-empty ${label}.`,
    );
  }
  if (buffer.length > maximumBytes) {
    throw new SocialPromotionValidationError(
      `SOCIAL_${codeLabel}_TOO_LARGE`,
      `The ${label} is too large.`,
      413,
    );
  }
}

export type SocialPromotionImageUpload = {
  checksumSha256: string;
  height: number;
  mimeType: string;
  name: string;
  sizeBytes: number;
  url: string;
  width: number;
};

export async function uploadSocialPromotionImage(
  input: {
    buffer: Buffer;
    businessId: string;
    declaredMimeType: string;
    originalName: string;
    scope?: SocialReferenceImageScope;
  },
  dependencies: {
    upload?: typeof uploadImageBufferWithMetadata;
  } = {},
): Promise<SocialPromotionImageUpload> {
  assertNonEmptyFile(
    input.buffer,
    SOCIAL_PROMOTION_IMAGE_MAX_BYTES,
    "promotion image",
  );
  let inspection;
  try {
    inspection = inspectImageUpload(input.buffer, input.declaredMimeType, {
      maxBytes: SOCIAL_PROMOTION_IMAGE_MAX_BYTES,
      minDimension: 64,
      maxDimension: 8_192,
      maxPixels: 40_000_000,
    });
  } catch (error) {
    if (error instanceof OnboardingV2AuthorImageValidationError) {
      throw new SocialPromotionValidationError(
        "SOCIAL_PROMOTION_IMAGE_INVALID",
        error.message,
        error.statusCode,
      );
    }
    throw error;
  }
  const receipt = await (dependencies.upload ?? uploadImageBufferWithMetadata)(
    input.buffer,
    inspection.mimeType,
    {
      folder: input.scope
        ? `social-references/${input.businessId}/${input.scope}`
        : `social-promotions/${input.businessId}`,
      publicId: `reference-${inspection.checksumSha256.slice(0, 24).toLowerCase()}`,
    },
  );
  return {
    checksumSha256: inspection.checksumSha256,
    height: inspection.height,
    mimeType: inspection.mimeType,
    name: safeSocialPromotionFileName(input.originalName, "promotion-image"),
    sizeBytes: inspection.sizeBytes,
    url: receipt.url,
    width: inspection.width,
  };
}

export type SocialPromotionDocumentUpload = {
  checksumSha256: string;
  mimeType: PromotionDocumentMimeType;
  name: string;
  sizeBytes: number;
  text: string;
};

type PromotionDocumentDependencies = {
  parseDocx?: (buffer: Buffer) => Promise<string>;
  parsePdf?: (buffer: Buffer) => Promise<string>;
};

async function parsePdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function parseDocxText(buffer: Buffer): Promise<string> {
  return (await mammoth.extractRawText({ buffer })).value;
}

function decodedUtf8Text(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SocialPromotionValidationError(
      "SOCIAL_PROMOTION_DOCUMENT_ENCODING_INVALID",
      "Text promotion documents must use UTF-8 encoding.",
    );
  }
}

function assertPromotionDocumentSignature(
  buffer: Buffer,
  mimeType: PromotionDocumentMimeType,
) {
  const valid = {
    "application/pdf": buffer.subarray(0, 5).toString("ascii") === "%PDF-",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(buffer[2] ?? -1) &&
      [0x04, 0x06, 0x08].includes(buffer[3] ?? -1),
    "text/markdown": !buffer.includes(0),
    "text/plain": !buffer.includes(0),
  }[mimeType];
  if (!valid) {
    throw new SocialPromotionValidationError(
      "SOCIAL_PROMOTION_DOCUMENT_SIGNATURE_INVALID",
      "The promotion document contents do not match its declared file type.",
    );
  }
}

export async function extractSocialPromotionDocument(
  input: {
    buffer: Buffer;
    declaredMimeType: string;
    originalName: string;
  },
  dependencies: PromotionDocumentDependencies = {},
): Promise<SocialPromotionDocumentUpload> {
  assertNonEmptyFile(
    input.buffer,
    SOCIAL_PROMOTION_DOCUMENT_MAX_BYTES,
    "promotion document",
  );
  const mimeType = normalizedMimeType(input.declaredMimeType);
  if (!Object.hasOwn(SOCIAL_PROMOTION_DOCUMENT_MIME_TYPES, mimeType)) {
    throw new SocialPromotionValidationError(
      "SOCIAL_PROMOTION_DOCUMENT_TYPE_INVALID",
      "Choose a PDF, DOCX, TXT, or Markdown promotion document.",
    );
  }
  const supportedMimeType = mimeType as PromotionDocumentMimeType;
  assertPromotionDocumentSignature(input.buffer, supportedMimeType);

  let rawText: string;
  try {
    const extractors: Record<PromotionDocumentMimeType, () => Promise<string>> = {
      "application/pdf": () =>
        (dependencies.parsePdf ?? parsePdfText)(input.buffer),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        () => (dependencies.parseDocx ?? parseDocxText)(input.buffer),
      "text/markdown": async () => decodedUtf8Text(input.buffer),
      "text/plain": async () => decodedUtf8Text(input.buffer),
    };
    rawText = await extractors[supportedMimeType]();
  } catch (error) {
    if (error instanceof SocialPromotionValidationError) throw error;
    throw new SocialPromotionValidationError(
      "SOCIAL_PROMOTION_DOCUMENT_UNREADABLE",
      "The promotion document could not be read. Try another file or paste the key content directly.",
      422,
    );
  }
  const text = boundedPromotionText(
    rawText,
    SOCIAL_PROMOTION_DOCUMENT_TEXT_MAX_CHARACTERS,
  );
  if (text.length < 12) {
    throw new SocialPromotionValidationError(
      "SOCIAL_PROMOTION_DOCUMENT_TEXT_EMPTY",
      "The promotion document does not contain enough readable text.",
      422,
    );
  }
  return {
    checksumSha256: createHash("sha256")
      .update(input.buffer)
      .digest("hex")
      .toUpperCase(),
    mimeType: supportedMimeType,
    name: safeSocialPromotionFileName(
      input.originalName,
      `promotion.${SOCIAL_PROMOTION_DOCUMENT_MIME_TYPES[supportedMimeType]}`,
    ),
    sizeBytes: input.buffer.length,
    text,
  };
}

export function localDateInTimeZone(
  instant: Date,
  timeZone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function promotionText(value: unknown, maximumLength: number): string | null {
  const text = boundedPromotionText(value, maximumLength);
  return text || null;
}

export function normalizeSocialPromotionInput(
  input: SocialCreativePromotionInput | null | undefined,
): SocialCreativePromotion | null {
  if (!input?.enabled) return null;
  const title = promotionText(input.title, 160);
  const information = promotionText(input.information, 5_000);
  const startsOn = dateString(input.startsOn);
  const endsOn = dateString(input.endsOn);
  if (!title || !information || !startsOn || !endsOn || endsOn < startsOn) {
    return null;
  }
  const imageUrl = promotionText(input.imageUrl, 2_048);
  let approvedImageUrl: string | null = null;
  if (imageUrl) {
    try {
      const parsed = new URL(imageUrl);
      approvedImageUrl = parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      approvedImageUrl = null;
    }
  }
  return {
    enabled: true,
    title,
    information,
    preferredContent: promotionText(input.preferredContent, 5_000),
    startsOn,
    endsOn,
    imageUrl: approvedImageUrl,
    documentName: promotionText(input.documentName, 180),
    documentText: promotionText(
      input.documentText,
      SOCIAL_PROMOTION_DOCUMENT_TEXT_MAX_CHARACTERS,
    ),
  };
}

export function resolveSocialPromotionForInstant(input: {
  promotion: SocialCreativePromotionInput | null | undefined;
  scheduledFor: Date;
  timeZone: string;
}): SocialCreativePromotion | null {
  const promotion = normalizeSocialPromotionInput(input.promotion);
  if (!promotion) return null;
  let localDate: string;
  try {
    localDate = localDateInTimeZone(input.scheduledFor, input.timeZone);
  } catch {
    return null;
  }
  return localDate >= promotion.startsOn && localDate <= promotion.endsOn
    ? promotion
    : null;
}
