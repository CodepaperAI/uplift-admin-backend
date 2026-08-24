import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import z from "zod";

import { getBlogExternalLinkMetrics } from "./managed-backlinks.service";
import { buildExtendedBlogMeta } from "../utils/blog-seo.utils";

const RECOVERY_IMPORTER_VERSION = "recovery-draft-importer-v2";
const CANARY_APPROVAL = "APPROVE_PRODUCTION_CANARY";
const BATCH_APPROVAL = "APPROVE_PRODUCTION_BATCH_IMPORT";
const PRODUCTION_ENVIRONMENTS = new Set(["production", "prod"]);
const RECOVERY_ENTITLEMENT = z.enum(["paid", "trial"]);
const RECOVERY_BILLING_COHORT = z.enum([
  "website_paid",
  "website_paid_intro",
  "legacy_user_paid",
]);
const RECOVERY_PLAN_TIER = z.enum(["SEO", "SEO_SOCIAL"]);

function recoveryPotentialAnalytics(input: {
  content: string;
  seoScore: number | undefined;
  businessWebsiteUrl: string;
}): Prisma.InputJsonObject {
  if (input.seoScore === undefined) return {};
  const rankingPotential =
    input.seoScore >= 80 ? "HIGH" : input.seoScore >= 50 ? "MEDIUM" : "LOW";
  const hasConversionLanguage =
    /\b(contact|book|schedule|request|call|consult|get started|next step)\b/i.test(
      input.content.replace(/<[^>]+>/g, " "),
    );
  const escapedBusinessHost = new URL(input.businessWebsiteUrl).hostname
    .replace(/^www\./, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasBusinessCtaLink = new RegExp(
    `<a\\b[^>]*href=["']https?://(?:www\\.)?${escapedBusinessHost}[^"']*["'][^>]*>`,
    "i",
  ).test(input.content);
  const conversionPotential =
    hasConversionLanguage && hasBusinessCtaLink
      ? "HIGH"
      : hasConversionLanguage
        ? "MEDIUM"
        : "LOW";
  const { totalExternalLinks } = getBlogExternalLinkMetrics({
    html: input.content,
    sourceBaseUrl: input.businessWebsiteUrl,
    currentBusinessWebsiteUrl: input.businessWebsiteUrl,
  });
  return {
    rankingPotential,
    conversionPotential,
    externalLinksCount: totalExternalLinks,
  };
}

const SHORT_ID = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const BOUNDED_TEXT = z.string().trim().min(1).max(2_000);
const SMALL_TEXT = z.string().trim().min(1).max(500);
const HTTPS_URL = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Expected an absolute HTTPS URL");
const HTTP_URL = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Expected an absolute HTTP(S) URL");
const APPROVED_HOST = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  )
  .refine((value) => value === value.toLocaleLowerCase(), "Host must be lowercase");

const STRING_LIST_ITEM = z.string().trim().min(1).max(120);
const RECOVERY_META_PAYLOAD = z
  .object({
    seo_title: z.string().trim().min(1).max(200),
    seo_description: z.string().trim().min(1).max(500),
    focus_keyword: z.string().trim().min(1).max(200),
    keywords: z.array(STRING_LIST_ITEM).max(50),
    og_title: z.string().trim().min(1).max(200).optional(),
    og_description: z.string().trim().min(1).max(500).optional(),
    og_type: z.string().trim().min(1).max(50).optional(),
    og_url: HTTPS_URL.optional(),
    og_site_name: z.string().trim().min(1).max(200).optional(),
    og_locale: z.string().trim().min(1).max(35).optional(),
    article_author: z.string().trim().min(1).max(200).optional(),
    article_section: z.string().trim().min(1).max(120).optional(),
    article_tags: z.array(STRING_LIST_ITEM).max(50).optional(),
  })
  .strict();

const RECOVERY_BLOG_PAYLOAD = z
  .object({
    businessId: SHORT_ID,
    title: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.enum(["DRAFT", "PUBLISH"]).default("DRAFT"),
    author: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(2_000_000),
    excerpt: z.string().max(2_000),
    categories: z.array(STRING_LIST_ITEM).max(20),
    tags: z.array(STRING_LIST_ITEM).max(50),
    featured_media: z.union([z.literal(""), HTTPS_URL]),
    seoScore: z.number().int().min(0).max(100).optional(),
    meta: RECOVERY_META_PAYLOAD,
    custom_fields: z
      .object({
        reading_time: z.string().trim().min(1).max(80),
        rating: z.number().int().min(0).max(10),
      })
      .strict(),
    blogPublishInfo: z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
      })
      .strict(),
  })
  .strict();

const VERIFIED_CANONICAL = z
  .object({
    url: HTTPS_URL,
    verified: z.literal(true),
  })
  .strict()
  .optional();

const SCHEMA_ENTITY_IDENTITY = {
  "@id": HTTPS_URL.optional(),
  url: HTTPS_URL.optional(),
};
const SCHEMA_IMAGE_OBJECT = z
  .object({
    "@type": z.literal("ImageObject"),
    ...SCHEMA_ENTITY_IDENTITY,
    contentUrl: HTTPS_URL.optional(),
    caption: z.string().trim().min(1).max(500).optional(),
    width: z.number().int().positive().max(20_000).optional(),
    height: z.number().int().positive().max(20_000).optional(),
  })
  .strict();
const SCHEMA_IMAGE = z.union([HTTPS_URL, SCHEMA_IMAGE_OBJECT]);
const SCHEMA_AUTHOR = z.union([
  z
    .object({
      "@type": z.literal("Person"),
      name: z.string().trim().min(1).max(200),
      ...SCHEMA_ENTITY_IDENTITY,
    })
    .strict(),
  z
    .object({
      "@type": z.literal("Organization"),
      name: z.string().trim().min(1).max(200),
      ...SCHEMA_ENTITY_IDENTITY,
    })
    .strict(),
]);
const SCHEMA_PUBLISHER = z
  .object({
    "@type": z.literal("Organization"),
    name: z.string().trim().min(1).max(200),
    ...SCHEMA_ENTITY_IDENTITY,
    logo: SCHEMA_IMAGE.optional(),
  })
  .strict();
const SCHEMA_WEB_PAGE = z
  .object({
    "@type": z.literal("WebPage"),
    ...SCHEMA_ENTITY_IDENTITY,
  })
  .strict()
  .refine((value) => Boolean(value["@id"] || value.url), {
    message: "WebPage requires @id or url",
  });
const SCHEMA_DATE = z.union([z.iso.date(), z.iso.datetime()]);

const RECOVERY_STRUCTURED_DATA = z
  .object({
    "@context": z.literal("https://schema.org"),
    "@type": z.enum(["BlogPosting", "Article"]),
    ...SCHEMA_ENTITY_IDENTITY,
    headline: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(500).optional(),
    mainEntityOfPage: z.union([HTTPS_URL, SCHEMA_WEB_PAGE]).optional(),
    author: SCHEMA_AUTHOR.optional(),
    image: SCHEMA_IMAGE.optional(),
    publisher: SCHEMA_PUBLISHER.optional(),
    datePublished: SCHEMA_DATE.optional(),
    dateModified: SCHEMA_DATE.optional(),
    inLanguage: z.string().trim().min(2).max(35).optional(),
    wordCount: z.number().int().positive().max(2_000_000).optional(),
    about: z
      .union([
        z.string().trim().min(1).max(200),
        z.array(z.string().trim().min(1).max(200)).min(1).max(50),
      ])
      .optional(),
  })
  .strict();

export const RECOVERY_DRAFT_PACKAGE = z
  .object({
    schemaVersion: z.literal(1),
    packageId: SHORT_ID,
    batchId: SHORT_ID,
    planId: SHORT_ID,
    userId: SHORT_ID,
    businessId: SHORT_ID,
    entitlement: RECOVERY_ENTITLEMENT.optional(),
    billingCohort: RECOVERY_BILLING_COHORT.optional(),
    planTier: RECOVERY_PLAN_TIER.nullable().optional(),
    route: z
      .object({
        action: z.literal("create_blog"),
        intentFingerprint: z.string().trim().min(1).max(300),
        rationale: BOUNDED_TEXT,
      })
      .strict(),
    validation: z
      .object({
        status: z.literal("approved"),
        validatorVersion: SHORT_ID,
        validatedAt: z.iso.datetime(),
        blockers: z.array(SMALL_TEXT).max(0),
        warnings: z.array(SMALL_TEXT).max(25).default([]),
      })
      .strict(),
    provenance: z
      .object({
        engineVersion: SHORT_ID,
        sourceUrls: z.array(HTTP_URL).min(1).max(50),
        researchRetrievedAt: z.iso.datetime(),
        researchArtifactId: z.string().trim().min(1).max(300),
        titleStrategy: z
          .object({
            playbookVersion: SHORT_ID,
            archetype: SHORT_ID,
            label: SMALL_TEXT,
            rationale: BOUNDED_TEXT,
            variationFamily: z.enum([
              "question",
              "plain",
              "colon",
              "comparison",
              "numbered",
            ]),
            sourceIntent: z
              .enum([
                "informational",
                "commercial-investigation",
                "transactional-or-service",
                "ambiguous",
              ])
              .nullable()
              .optional(),
            topicDirective: BOUNDED_TEXT.nullable().optional(),
            selectedArticleTopic: BOUNDED_TEXT.optional(),
            substantiveItemCount: z.number().int().min(2).max(50).nullable().optional(),
            serpValidation: z
              .object({
                decision: z.literal("blog-owned"),
                resultCount: z.number().int().min(3).max(100),
                blogPageCount: z.number().int().min(0).max(100),
                moneyPageCount: z.number().int().min(0).max(100),
                dominantFormat: z.string().trim().min(1).max(80).nullable(),
                rationale: BOUNDED_TEXT,
              })
              .strict()
              .optional(),
            serpCapturedAt: z.iso.datetime().optional(),
            serpRefinementFallback: z
              .object({
                selectionSource: z.literal(
                  "playbook-refinement-with-cited-seed-evidence",
                ),
                seedDecision: z.literal("money-page-owned"),
                reason: z.literal(
                  "two_refinement_queries_returned_no_citations",
                ),
                failedProviderAttempts: z
                  .array(z.number().int().min(1).max(100))
                  .length(2),
              })
              .strict()
              .optional(),
            selectionSource: z
              .enum(["model", "deterministic_fallback"])
              .optional(),
            modelFailures: z.array(SMALL_TEXT).max(25).optional(),
            allocation: z
              .object({
                schemaVersion: z.literal(
                  "recovery-title-strategy-assignments-v1",
                ),
                inventoryDigestSha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/),
                selectionOrder: z.number().int().min(1).max(100_000),
                candidateFamilies: z
                  .array(
                    z.enum([
                      "question",
                      "plain",
                      "colon",
                      "comparison",
                      "numbered",
                    ]),
                  )
                  .min(1)
                  .max(5),
                recentFamilies: z
                  .array(
                    z.enum([
                      "question",
                      "plain",
                      "colon",
                      "comparison",
                      "numbered",
                    ]),
                  )
                  .max(50),
                recentTitles: z
                  .array(z.string().trim().min(1).max(300))
                  .max(12)
                  .optional(),
                strategy: z
                  .object({
                    archetype: SHORT_ID,
                    label: SMALL_TEXT,
                    rationale: BOUNDED_TEXT,
                    preferredTitleShapes: z
                      .array(SMALL_TEXT)
                      .min(1)
                      .max(25),
                    allowedSpecificityHooks: z
                      .array(SMALL_TEXT)
                      .max(25),
                    variationFamily: z.enum([
                      "question",
                      "plain",
                      "colon",
                      "comparison",
                      "numbered",
                    ]),
                    sourceIntent: z
                      .enum([
                        "informational",
                        "commercial-investigation",
                        "transactional-or-service",
                        "ambiguous",
                      ])
                      .nullable(),
                    requiresSerpValidation: z.boolean(),
                    topicDirective: BOUNDED_TEXT.nullable(),
                    substantiveItemCount: z
                      .number()
                      .int()
                      .min(2)
                      .max(50)
                      .nullable(),
                  })
                  .strict(),
              })
              .strict()
              .nullable()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    canonical: VERIFIED_CANONICAL,
    structuredData: RECOVERY_STRUCTURED_DATA.optional(),
    blog: RECOVERY_BLOG_PAYLOAD,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.blog.businessId !== value.businessId) {
      ctx.addIssue({
        code: "custom",
        path: ["blog", "businessId"],
        message: "Blog businessId must match the recovery package businessId",
      });
    }

    const cohortMatchesEntitlement =
      value.billingCohort === undefined ||
      (value.billingCohort === "website_paid_intro" &&
        value.entitlement === "trial" &&
        value.planTier != null) ||
      (value.billingCohort === "website_paid" &&
        (value.entitlement === undefined || value.entitlement === "paid") &&
        value.planTier != null) ||
      (value.billingCohort === "legacy_user_paid" &&
        (value.entitlement === undefined || value.entitlement === "paid") &&
        value.planTier == null);
    if (!cohortMatchesEntitlement) {
      ctx.addIssue({
        code: "custom",
        path: ["billingCohort"],
        message: "Billing cohort, entitlement, and plan tier must agree",
      });
    }

    if (
      new Date(value.validation.validatedAt).getTime() <
      new Date(value.provenance.researchRetrievedAt).getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validation", "validatedAt"],
        message: "Validation cannot predate the research retrieval time",
      });
    }
  });

const APPROVED_MANIFEST_ENTRY = z
  .object({
    packageId: SHORT_ID,
    planId: SHORT_ID,
    userId: SHORT_ID,
    businessId: SHORT_ID,
    entitlement: RECOVERY_ENTITLEMENT.optional(),
    billingCohort: RECOVERY_BILLING_COHORT.optional(),
    planTier: RECOVERY_PLAN_TIER.nullable().optional(),
    route: z.literal("CREATE"),
    generationAuthorized: z.literal(true),
    validation: z
      .object({
        status: z.literal("approved"),
        blockers: z.array(SMALL_TEXT).max(0),
        validatorVersion: SHORT_ID,
      })
      .strict(),
    approvedBusinessHost: APPROVED_HOST,
    approvedCanonicalUrl: HTTPS_URL.nullable(),
    packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const RECOVERY_APPROVED_MANIFEST = z
  .object({
    schemaVersion: z.literal(1),
    manifestId: SHORT_ID,
    batchId: SHORT_ID,
    mode: z.enum(["canary", "batch"]),
    generatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    approval: z
      .object({
        status: z.literal("approved"),
        approvedAt: z.iso.datetime(),
        approvedBy: z.string().trim().min(1).max(200),
      })
      .strict(),
    entries: z.array(APPROVED_MANIFEST_ENTRY).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const packageIds = new Set<string>();
    const planIds = new Set<string>();
    value.entries.forEach((entry, index) => {
      if (packageIds.has(entry.packageId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "packageId"],
          message: "Manifest package IDs must be unique",
        });
      }
      if (planIds.has(entry.planId)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "planId"],
          message: "Manifest Plan IDs must be unique",
        });
      }
      packageIds.add(entry.packageId);
      planIds.add(entry.planId);
    });
    if (
      new Date(value.generatedAt).getTime() >
      new Date(value.expiresAt).getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Manifest expiry must follow generation",
      });
    }
    if (
      new Date(value.approval.approvedAt).getTime() >
      new Date(value.expiresAt).getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["approval", "approvedAt"],
        message: "Manifest approval must precede expiry",
      });
    }
  });

export type RecoveryDraftPackage = z.infer<typeof RECOVERY_DRAFT_PACKAGE>;
export type RecoveryApprovedManifest = z.infer<
  typeof RECOVERY_APPROVED_MANIFEST
>;

export type RecoveryImportBlockCode =
  | "plan_not_found"
  | "ownership_mismatch"
  | "business_inactive"
  | "paid_subscription_inactive"
  | "trial_entitlement_inactive"
  | "plan_tier_drift"
  | "plan_deleted"
  | "plan_already_linked"
  | "plan_keyword_mismatch"
  | "duplicate_slug"
  | "duplicate_title"
  | "duplicate_focus_keyword"
  | "duplicate_canonical"
  | "duplicate_intent"
  | "plan_state_inconsistent"
  | "business_host_mismatch"
  | "stale_plan_race"
  | "simulated_failure";

export type RecoveryImportResult = {
  packageId: string;
  batchId: string;
  planId: string;
  businessId: string;
  mode: "dry-run" | "apply";
  status: "ready" | "imported" | "already_imported" | "blocked";
  blogId: string | null;
  blockCodes: RecoveryImportBlockCode[];
  authorizationReceipt: {
    manifestId: string;
    batchId: string;
    mode: "canary" | "batch";
    packageDigest: string;
  } | null;
  proposedMutation: {
    createMeta: boolean;
    createCustomField: boolean;
    createBlog: boolean;
    linkPlan: boolean;
    forcedStatus: "DRAFT";
    publishDateSource: "plan";
  };
  mutationReceipt: {
    plan: {
      before: {
        blogId: string | null;
        isUsed: boolean;
        usedAt: string | null;
      };
      after: {
        blogId: string | null;
        isUsed: boolean;
        usedAt: string | null;
      };
    };
    blog: {
      id: string | null;
      status: "DRAFT" | "PUBLISH";
      publishDate: string;
      publishTime: string;
      canonicalUrl: string | null;
    } | null;
  } | null;
};

export type RecoveryImportOptions = {
  apply?: boolean;
  now?: Date;
  simulateFailureAt?: "after_blog_create";
  authorization?: {
    manifest: unknown;
    confirmBatch: string;
    approval: string;
    invocationPackageCount: number;
  };
};

export type RecoveryImportAuthorizationCode =
  | "apply_disabled"
  | "authorization_missing"
  | "runtime_environment_unset"
  | "runtime_environment_conflict"
  | "production_apply_disabled"
  | "approval_invalid"
  | "batch_confirmation_mismatch"
  | "manifest_invalid"
  | "manifest_expired"
  | "manifest_entry_missing"
  | "manifest_binding_mismatch"
  | "package_digest_mismatch"
  | "canonical_binding_mismatch"
  | "canary_cardinality_invalid"
  | "one_package_apply_required";

export class RecoveryImportAuthorizationError extends Error {
  constructor(
    public readonly code: RecoveryImportAuthorizationCode,
    message: string,
  ) {
    super(message);
    this.name = "RecoveryImportAuthorizationError";
  }
}

class RecoveryImportRollback extends Error {
  constructor(public readonly code: RecoveryImportBlockCode) {
    super(code);
    this.name = "RecoveryImportRollback";
  }
}

type VerifiedApplyAuthorization = {
  manifest: RecoveryApprovedManifest;
  entry: RecoveryApprovedManifest["entries"][number];
  packageDigest: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot digest a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Cannot digest a non-JSON value");
}

function digestParsedPackage(pkg: RecoveryDraftPackage): string {
  return createHash("sha256").update(canonicalJson(pkg)).digest("hex");
}

export function computeRecoveryPackageDigest(rawPackage: unknown): string {
  return digestParsedPackage(RECOVERY_DRAFT_PACKAGE.parse(rawPackage));
}

function runtimeMarkers(): Array<{ key: string; value: string }> {
  return ["APP_ENV", "DEPLOY_ENV", "ENVIRONMENT", "NODE_ENV"].flatMap((key) => {
    const value = process.env[key]?.trim().toLocaleLowerCase();
    return value ? [{ key, value }] : [];
  });
}

export function getRecoveryRuntimeEnvironment(): {
  value: string;
  isProduction: boolean;
  markers: Array<{ key: string; value: string }>;
} {
  const markers = runtimeMarkers();
  const values = [...new Set(markers.map((marker) => marker.value))];
  return {
    value: values.length === 0 ? "unset" : values.join(","),
    isProduction: values.some((value) => PRODUCTION_ENVIRONMENTS.has(value)),
    markers,
  };
}

function hostname(value: string): string {
  return new URL(value).hostname.toLocaleLowerCase();
}

function authorizationError(
  code: RecoveryImportAuthorizationCode,
  message: string,
): never {
  throw new RecoveryImportAuthorizationError(code, message);
}

function verifyApplyAuthorization(
  pkg: RecoveryDraftPackage,
  options: RecoveryImportOptions,
): VerifiedApplyAuthorization {
  if (process.env.RECOVERY_DRAFT_IMPORT_ENABLED !== "true") {
    authorizationError(
      "apply_disabled",
      "Apply blocked: RECOVERY_DRAFT_IMPORT_ENABLED must be explicitly set to true",
    );
  }

  const environment = getRecoveryRuntimeEnvironment();
  const values = [...new Set(environment.markers.map((marker) => marker.value))];
  if (values.length === 0) {
    authorizationError(
      "runtime_environment_unset",
      "Apply blocked: a runtime environment marker is required",
    );
  }
  if (values.length > 1) {
    authorizationError(
      "runtime_environment_conflict",
      "Apply blocked: runtime environment markers are contradictory",
    );
  }

  const authorization = options.authorization;
  if (!authorization) {
    authorizationError(
      "authorization_missing",
      "Apply blocked: an approved recovery manifest authorization is required",
    );
  }
  if (authorization.invocationPackageCount !== 1) {
    authorizationError(
      "one_package_apply_required",
      "Apply blocked: exactly one package is allowed per apply invocation",
    );
  }

  let manifest: RecoveryApprovedManifest;
  try {
    manifest = RECOVERY_APPROVED_MANIFEST.parse(authorization.manifest);
  } catch {
    authorizationError(
      "manifest_invalid",
      "Apply blocked: approved manifest is invalid",
    );
  }

  if (
    authorization.confirmBatch !== pkg.batchId ||
    authorization.confirmBatch !== manifest.batchId
  ) {
    authorizationError(
      "batch_confirmation_mismatch",
      "Apply blocked: confirmed batch does not match package and manifest",
    );
  }

  const expectedApproval =
    manifest.mode === "canary" ? CANARY_APPROVAL : BATCH_APPROVAL;
  if (authorization.approval !== expectedApproval) {
    authorizationError(
      "approval_invalid",
      "Apply blocked: approval phrase does not match manifest mode",
    );
  }
  if (manifest.mode === "canary" && manifest.entries.length !== 1) {
    authorizationError(
      "canary_cardinality_invalid",
      "Apply blocked: canary manifest must authorize exactly one package",
    );
  }

  if (environment.isProduction) {
    if (process.env.RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED !== "true") {
      authorizationError(
        "production_apply_disabled",
        "Production apply blocked: RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED must be explicitly set to true",
      );
    }
    if (![CANARY_APPROVAL, BATCH_APPROVAL].includes(authorization.approval)) {
      authorizationError(
        "approval_invalid",
        "Production apply blocked: an exact approval phrase is required",
      );
    }
  }

  const wallClock = Date.now();
  if (
    new Date(manifest.generatedAt).getTime() > wallClock ||
    new Date(manifest.approval.approvedAt).getTime() > wallClock ||
    new Date(manifest.expiresAt).getTime() <= wallClock
  ) {
    authorizationError(
      "manifest_expired",
      "Apply blocked: approved manifest is not currently valid",
    );
  }

  const entry = manifest.entries.find(
    (candidate) => candidate.packageId === pkg.packageId,
  );
  if (!entry) {
    authorizationError(
      "manifest_entry_missing",
      "Apply blocked: package is not present in approved manifest",
    );
  }

  if (
    entry.planId !== pkg.planId ||
    entry.userId !== pkg.userId ||
    entry.businessId !== pkg.businessId ||
    (entry.entitlement ?? "paid") !== (pkg.entitlement ?? "paid") ||
    entry.billingCohort !== pkg.billingCohort ||
    entry.planTier !== pkg.planTier ||
    entry.route !== "CREATE" ||
    entry.generationAuthorized !== true ||
    entry.validation.status !== "approved" ||
    entry.validation.blockers.length !== 0 ||
    entry.validation.validatorVersion !== pkg.validation.validatorVersion
  ) {
    authorizationError(
      "manifest_binding_mismatch",
      "Apply blocked: package identity or route does not match approved manifest",
    );
  }

  const packageDigest = digestParsedPackage(pkg);
  if (entry.packageDigest !== packageDigest) {
    authorizationError(
      "package_digest_mismatch",
      "Apply blocked: package digest does not match approved manifest",
    );
  }

  const packageCanonical = pkg.canonical?.url ?? null;
  if (
    normalizeUrl(packageCanonical) !== normalizeUrl(entry.approvedCanonicalUrl) ||
    (packageCanonical && hostname(packageCanonical) !== entry.approvedBusinessHost)
  ) {
    authorizationError(
      "canonical_binding_mismatch",
      "Apply blocked: canonical does not match the approved business host and manifest target",
    );
  }

  return { manifest, entry, packageDigest };
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function normalizeUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLocaleLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, "").toLocaleLowerCase();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function recoveryRecord(value: unknown): Record<string, unknown> {
  return asRecord(asRecord(value).recovery);
}

function emptyMutation(): RecoveryImportResult["proposedMutation"] {
  return {
    createMeta: false,
    createCustomField: false,
    createBlog: false,
    linkPlan: false,
    forcedStatus: "DRAFT",
    publishDateSource: "plan",
  };
}

function fullMutation(): RecoveryImportResult["proposedMutation"] {
  return {
    createMeta: true,
    createCustomField: true,
    createBlog: true,
    linkPlan: true,
    forcedStatus: "DRAFT",
    publishDateSource: "plan",
  };
}

function baseResult(
  pkg: RecoveryDraftPackage,
  apply: boolean,
  authorization: VerifiedApplyAuthorization | null,
): Omit<
  RecoveryImportResult,
  "status" | "blogId" | "blockCodes" | "proposedMutation" | "mutationReceipt"
> {
  return {
    packageId: pkg.packageId,
    batchId: pkg.batchId,
    planId: pkg.planId,
    businessId: pkg.businessId,
    mode: apply ? "apply" : "dry-run",
    authorizationReceipt: authorization
      ? {
          manifestId: authorization.manifest.manifestId,
          batchId: authorization.manifest.batchId,
          mode: authorization.manifest.mode,
          packageDigest: authorization.packageDigest,
        }
      : null,
  };
}

function blockedResult(
  pkg: RecoveryDraftPackage,
  apply: boolean,
  authorization: VerifiedApplyAuthorization | null,
  blockCodes: RecoveryImportBlockCode[],
): RecoveryImportResult {
  return {
    ...baseResult(pkg, apply, authorization),
    status: "blocked",
    blogId: null,
    blockCodes: [...new Set(blockCodes)],
    proposedMutation: emptyMutation(),
    mutationReceipt: null,
  };
}

function dateString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isActivePaidWebsiteSubscription(subscription: {
  status: string;
  trialStatus: string;
} | null): boolean {
  // Active paid website access is represented by status=active and either no
  // trial lifecycle or a converted trial. Expired/trialing/inconsistent states
  // fail closed even if status was left stale as active.
  return Boolean(
    subscription &&
      subscription.status === "active" &&
      ["none", "converted"].includes(subscription.trialStatus),
  );
}

function isActivePaidEntitlement(input: {
  websiteSubscription: {
    status: string;
    trialStatus: string;
  } | null;
  user: {
    role: string;
    Subscription: { status: string } | null;
  } | null;
}): boolean {
  return Boolean(
    input.user &&
      (input.user.role === "ADMIN" ||
        input.user.role === "SUPERADMIN" ||
        input.user.Subscription?.status === "active" ||
        isActivePaidWebsiteSubscription(input.websiteSubscription)),
  );
}

function isCurrentTrialWindow(
  trialStartDate: Date | null,
  trialEndDate: Date | null,
  now: Date,
): boolean {
  return Boolean(
    trialStartDate &&
      trialEndDate &&
      trialStartDate.getTime() <= now.getTime() &&
      trialEndDate.getTime() > now.getTime(),
  );
}

function isActiveTrialEntitlement(
  websiteSubscription: {
    status: string;
    trialStatus: string;
    trialStartDate: Date | null;
    trialEndDate: Date | null;
  } | null,
  user: {
    trialStatus: string | null;
    trialStartDate: Date | null;
    trialEndDate: Date | null;
  } | null,
  now: Date,
): boolean {
  const activeWebsiteTrial = Boolean(
    websiteSubscription &&
      ["active", "trialing"].includes(websiteSubscription.status) &&
      websiteSubscription.trialStatus === "trialing" &&
      isCurrentTrialWindow(
        websiteSubscription.trialStartDate,
        websiteSubscription.trialEndDate,
        now,
      ),
  );
  const activeUserTrial = Boolean(
    user &&
      user.trialStatus === "active" &&
      isCurrentTrialWindow(user.trialStartDate, user.trialEndDate, now),
  );
  return activeWebsiteTrial || activeUserTrial;
}

function recoveryBillingCohortIsActive(
  billingCohort: z.infer<typeof RECOVERY_BILLING_COHORT>,
  websiteSubscription: {
    stripeSubscriptionId?: string | null;
    status: string;
    trialStatus: string;
    trialStartDate: Date | null;
    trialEndDate: Date | null;
  } | null,
  user: {
    Subscription: { status: string } | null;
  } | null,
  now: Date,
): boolean {
  if (billingCohort === "website_paid") {
    return isActivePaidWebsiteSubscription(websiteSubscription);
  }
  if (billingCohort === "website_paid_intro") {
    return Boolean(
      websiteSubscription?.stripeSubscriptionId &&
        ["active", "trialing"].includes(websiteSubscription.status) &&
        websiteSubscription.trialStatus === "trialing" &&
        isCurrentTrialWindow(
          websiteSubscription.trialStartDate,
          websiteSubscription.trialEndDate,
          now,
        ),
    );
  }
  return user?.Subscription?.status === "active";
}

export async function importRecoveryDraft(
  prisma: PrismaClient,
  rawPackage: unknown,
  options: RecoveryImportOptions = {},
): Promise<RecoveryImportResult> {
  const pkg = RECOVERY_DRAFT_PACKAGE.parse(rawPackage);
  const apply = options.apply === true;
  const now = options.now ?? new Date();
  const authorization = apply ? verifyApplyAuthorization(pkg, options) : null;

  try {
    return await prisma.$transaction(
      async (tx) => {
        const plan = await tx.plan.findUnique({
          where: { id: pkg.planId },
          select: {
            id: true,
            userId: true,
            businessId: true,
            keyword: true,
            publishDate: true,
            publishTime: true,
            blogId: true,
            isUsed: true,
            usedAt: true,
            deletedAt: true,
            business: {
              select: {
                userId: true,
                isActive: true,
                websiteStatus: true,
                businessWebsiteUrl: true,
                businessName: true,
                authorName: true,
                authorBio: true,
                authorImage: true,
                authorSocialLinks: true,
                defaultLocale: true,
                websiteSubscription: {
                  select: {
                    stripeSubscriptionId: true,
                    planTier: true,
                    status: true,
                    trialStatus: true,
                    trialStartDate: true,
                    trialEndDate: true,
                  },
                },
                User: {
                  select: {
                    id: true,
                    role: true,
                    trialStatus: true,
                    trialStartDate: true,
                    trialEndDate: true,
                    Subscription: {
                      select: {
                        status: true,
                      },
                    },
                  },
                },
              },
            },
            blog: {
              select: {
                id: true,
                userId: true,
                businessId: true,
                status: true,
                blogPublishDate: true,
                blogPublishTime: true,
                canonicalUrl: true,
                analytics: true,
              },
            },
          },
        });

        if (!plan) {
          return blockedResult(pkg, apply, authorization, ["plan_not_found"]);
        }

        const ownershipMismatch =
          plan.userId !== pkg.userId ||
          plan.businessId !== pkg.businessId ||
          plan.business?.userId !== pkg.userId;
        if (ownershipMismatch) {
          return blockedResult(pkg, apply, authorization, ["ownership_mismatch"]);
        }

        if (plan.deletedAt) {
          return blockedResult(pkg, apply, authorization, ["plan_deleted"]);
        }

        if (
          !plan.business?.isActive ||
          (process.env.RECOVERY_SCHEDULER_ELIGIBLE_BUSINESS_STATUS !== "true" &&
            (pkg.entitlement === "trial"
              ? !["active", "trial"].includes(plan.business.websiteStatus)
              : plan.business.websiteStatus !== "active"))
        ) {
          return blockedResult(pkg, apply, authorization, ["business_inactive"]);
        }

        if (
          pkg.planTier != null &&
          plan.business.websiteSubscription?.planTier !== pkg.planTier
        ) {
          return blockedResult(pkg, apply, authorization, ["plan_tier_drift"]);
        }

        if (
          pkg.billingCohort &&
          !recoveryBillingCohortIsActive(
            pkg.billingCohort,
            plan.business.websiteSubscription,
            plan.business.User,
            now,
          )
        ) {
          return blockedResult(pkg, apply, authorization, [
            pkg.entitlement === "trial"
              ? "trial_entitlement_inactive"
              : "paid_subscription_inactive",
          ]);
        } else if (pkg.entitlement === "trial") {
          if (
            !isActiveTrialEntitlement(
              plan.business.websiteSubscription,
              plan.business.User,
              now,
            )
          ) {
            return blockedResult(pkg, apply, authorization, [
              "trial_entitlement_inactive",
            ]);
          }
        } else if (
          !isActivePaidEntitlement({
            websiteSubscription: plan.business.websiteSubscription,
            user: plan.business.User,
          })
        ) {
          return blockedResult(pkg, apply, authorization, [
            "paid_subscription_inactive",
          ]);
        }

        if (
          authorization &&
          hostname(plan.business.businessWebsiteUrl) !==
            authorization.entry.approvedBusinessHost
        ) {
          return blockedResult(pkg, apply, authorization, ["business_host_mismatch"]);
        }

        const planStateInconsistent = plan.blogId
          ? !plan.isUsed || !plan.usedAt
          : plan.isUsed || Boolean(plan.usedAt);
        if (planStateInconsistent) {
          return blockedResult(pkg, apply, authorization, ["plan_state_inconsistent"]);
        }

        if (plan.blogId) {
          const linkedRecovery = recoveryRecord(plan.blog?.analytics);
          const linkedOwnershipMatches =
            plan.blog?.userId === pkg.userId &&
            plan.blog.businessId === pkg.businessId;
          const linkedAuthorizationMatches =
            !apply ||
            (authorization &&
              linkedRecovery.packageId === pkg.packageId &&
              linkedRecovery.packageDigest === authorization.packageDigest &&
              linkedRecovery.manifestId === authorization.manifest.manifestId);
          if (
            linkedOwnershipMatches &&
            linkedRecovery.planId === pkg.planId &&
            linkedAuthorizationMatches
          ) {
            return {
              ...baseResult(pkg, apply, authorization),
              status: "already_imported",
              blogId: plan.blogId,
              blockCodes: [],
              proposedMutation: emptyMutation(),
              mutationReceipt: {
                plan: {
                  before: {
                    blogId: plan.blogId,
                    isUsed: plan.isUsed,
                    usedAt: dateString(plan.usedAt),
                  },
                  after: {
                    blogId: plan.blogId,
                    isUsed: plan.isUsed,
                    usedAt: dateString(plan.usedAt),
                  },
                },
                blog: plan.blog
                  ? {
                      id: plan.blog.id,
                      status: plan.blog.status,
                      publishDate: plan.blog.blogPublishDate,
                      publishTime: plan.blog.blogPublishTime,
                      canonicalUrl: plan.blog.canonicalUrl,
                    }
                  : null,
              },
            };
          }
          return blockedResult(pkg, apply, authorization, ["plan_already_linked"]);
        }

        if (
          normalizeText(plan.keyword) !==
          normalizeText(pkg.blog.meta.focus_keyword)
        ) {
          return blockedResult(pkg, apply, authorization, ["plan_keyword_mismatch"]);
        }

        const existingBlogs = await tx.blog.findMany({
          where: {
            userId: pkg.userId,
            businessId: pkg.businessId,
          },
          select: {
            id: true,
            title: true,
            slug: true,
            canonicalUrl: true,
            analytics: true,
            meta: { select: { focus_keyword: true } },
          },
        });

        const duplicateCodes: RecoveryImportBlockCode[] = [];
        const candidateCanonical = pkg.canonical?.verified
          ? normalizeUrl(pkg.canonical.url)
          : "";
        for (const existing of existingBlogs) {
          if (existing.slug.trim().toLocaleLowerCase() === pkg.blog.slug.trim().toLocaleLowerCase()) {
            duplicateCodes.push("duplicate_slug");
          }
          if (normalizeText(existing.title) === normalizeText(pkg.blog.title)) {
            duplicateCodes.push("duplicate_title");
          }
          if (
            normalizeText(existing.meta.focus_keyword) ===
            normalizeText(pkg.blog.meta.focus_keyword)
          ) {
            duplicateCodes.push("duplicate_focus_keyword");
          }
          if (
            candidateCanonical &&
            normalizeUrl(existing.canonicalUrl) === candidateCanonical
          ) {
            duplicateCodes.push("duplicate_canonical");
          }
          if (
            recoveryRecord(existing.analytics).intentFingerprint ===
            pkg.route.intentFingerprint
          ) {
            duplicateCodes.push("duplicate_intent");
          }
        }

        const allowFreshCreateKeywordOverlap =
          pkg.provenance.engineVersion === "fresh-create-recovery-v1" &&
          pkg.route.intentFingerprint.startsWith("fresh-create:") &&
          duplicateCodes.every((code) => code === "duplicate_focus_keyword");
        if (duplicateCodes.length > 0 && !allowFreshCreateKeywordOverlap) {
          return blockedResult(pkg, apply, authorization, duplicateCodes);
        }

        if (!apply) {
          return {
            ...baseResult(pkg, apply, authorization),
            status: "ready",
            blogId: null,
            blockCodes: [],
            proposedMutation: fullMutation(),
            mutationReceipt: {
              plan: {
                before: {
                  blogId: plan.blogId,
                  isUsed: plan.isUsed,
                  usedAt: dateString(plan.usedAt),
                },
                after: {
                  blogId: null,
                  isUsed: true,
                  usedAt: null,
                },
              },
              blog: {
                id: null,
                status: "DRAFT",
                publishDate: plan.publishDate,
                publishTime: plan.publishTime,
                canonicalUrl: pkg.canonical?.verified
                  ? pkg.canonical.url
                  : null,
              },
            },
          };
        }

        const resolvedAuthorName =
          plan.business.authorName?.trim() ||
          pkg.blog.author.trim() ||
          plan.business.businessName;
        const authorSocialLinks = asRecord(plan.business.authorSocialLinks);
        const normalizedMeta = buildExtendedBlogMeta({
          title: pkg.blog.title,
          excerpt: pkg.blog.excerpt,
          slug: pkg.blog.slug,
          meta: pkg.blog.meta,
          categories: pkg.blog.categories,
          tags: pkg.blog.tags,
          authorName: resolvedAuthorName,
          businessName: plan.business.businessName,
          businessWebsiteUrl: plan.business.businessWebsiteUrl,
          defaultLocale: plan.business.defaultLocale,
        });
        const analytics: Prisma.InputJsonObject = {
          ...recoveryPotentialAnalytics({
            content: pkg.blog.content,
            seoScore: pkg.blog.seoScore,
            businessWebsiteUrl: plan.business.businessWebsiteUrl,
          }),
          seoMeta: JSON.parse(JSON.stringify(normalizedMeta)) as Prisma.InputJsonObject,
          recovery: {
            importerVersion: RECOVERY_IMPORTER_VERSION,
            schemaVersion: pkg.schemaVersion,
            packageId: pkg.packageId,
            batchId: pkg.batchId,
            planId: pkg.planId,
            manifestId: authorization!.manifest.manifestId,
            manifestMode: authorization!.manifest.mode,
            packageDigest: authorization!.packageDigest,
            intentFingerprint: pkg.route.intentFingerprint,
            engineVersion: pkg.provenance.engineVersion,
            validatorVersion: pkg.validation.validatorVersion,
            validatedAt: pkg.validation.validatedAt,
            researchRetrievedAt: pkg.provenance.researchRetrievedAt,
            researchArtifactId: pkg.provenance.researchArtifactId,
            sourceUrls: pkg.provenance.sourceUrls,
            ...(pkg.provenance.titleStrategy
              ? {
                  titleStrategy: JSON.parse(
                    JSON.stringify(pkg.provenance.titleStrategy),
                  ),
                }
              : {}),
            warnings: pkg.validation.warnings,
            routeRationale: pkg.route.rationale,
            ...(pkg.entitlement
              ? { entitlement: pkg.entitlement }
              : {}),
            ...(pkg.billingCohort
              ? { billingCohort: pkg.billingCohort }
              : {}),
            ...(pkg.planTier !== undefined ? { planTier: pkg.planTier } : {}),
            plannedCanonicalUrl: pkg.canonical?.url ?? null,
            canonicalVerified: pkg.canonical?.verified ?? false,
            structuredData: pkg.structuredData
              ? JSON.parse(JSON.stringify(pkg.structuredData))
              : null,
            importedAt: now.toISOString(),
          } as Prisma.InputJsonObject,
        };

        const meta = await tx.meta.create({
          data: {
            seo_title: normalizedMeta.seo_title,
            seo_description: normalizedMeta.seo_description,
            focus_keyword: normalizedMeta.focus_keyword,
            keywords: normalizedMeta.keywords,
          },
        });
        const customField = await tx.customField.create({
          data: {
            reading_time: pkg.blog.custom_fields.reading_time,
            rating: pkg.blog.custom_fields.rating,
          },
        });
        const blog = await tx.blog.create({
          data: {
            userId: pkg.userId,
            businessId: pkg.businessId,
            title: pkg.blog.title,
            slug: pkg.blog.slug,
            status: "DRAFT",
            content: pkg.blog.content,
            excerpt: pkg.blog.excerpt,
            categories: pkg.blog.categories,
            tags: pkg.blog.tags,
            featured_media: pkg.blog.featured_media,
            blogPublishDate: plan.publishDate,
            blogPublishTime: plan.publishTime,
            seoScore: pkg.blog.seoScore ?? null,
            analytics,
            canonicalUrl: pkg.canonical?.verified ? pkg.canonical.url : null,
            authorName: resolvedAuthorName,
            authorBio: plan.business.authorBio || null,
            authorUrl:
              typeof authorSocialLinks.website === "string"
                ? authorSocialLinks.website
                : plan.business.businessWebsiteUrl || null,
            authorImage: plan.business.authorImage || null,
            metaId: meta.id,
            customFieldId: customField.id,
          },
        });

        if (options.simulateFailureAt === "after_blog_create") {
          throw new RecoveryImportRollback("simulated_failure");
        }

        const linked = await tx.plan.updateMany({
          where: {
            id: pkg.planId,
            userId: pkg.userId,
            businessId: pkg.businessId,
            deletedAt: null,
            blogId: null,
            isUsed: false,
            usedAt: null,
          },
          data: {
            blogId: blog.id,
            isUsed: true,
            usedAt: now,
          },
        });

        if (linked.count !== 1) {
          throw new RecoveryImportRollback("stale_plan_race");
        }

        return {
          ...baseResult(pkg, apply, authorization),
          status: "imported",
          blogId: blog.id,
          blockCodes: [],
          proposedMutation: fullMutation(),
          mutationReceipt: {
            plan: {
              before: {
                blogId: null,
                isUsed: plan.isUsed,
                usedAt: dateString(plan.usedAt),
              },
              after: {
                blogId: blog.id,
                isUsed: true,
                usedAt: now.toISOString(),
              },
            },
            blog: {
              id: blog.id,
              status: "DRAFT",
              publishDate: plan.publishDate,
              publishTime: plan.publishTime,
              canonicalUrl: pkg.canonical?.verified
                ? pkg.canonical.url
                : null,
            },
          },
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  } catch (error) {
    if (error instanceof RecoveryImportRollback) {
      return blockedResult(pkg, apply, authorization, [error.code]);
    }
    throw error;
  }
}

export function getRecoveryImporterVersion(): string {
  return RECOVERY_IMPORTER_VERSION;
}
