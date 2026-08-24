import { createHash } from "node:crypto";

import z from "zod";

import {
  RECOVERY_APPROVED_MANIFEST,
  RECOVERY_DRAFT_PACKAGE,
  computeRecoveryPackageDigest,
  type RecoveryApprovedManifest,
  type RecoveryDraftPackage,
} from "./recovery-blog-importer.service";

const IDENTIFIER = z.string().trim().min(1).max(160);
const URL = z.url().refine((value) => {
  const protocol = new globalThis.URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
});
const LIST_ITEM = z.string().trim().min(1).max(120);

export const ISOLATED_EDITORIAL_SOURCE = z
  .object({
    schemaVersion: z.literal("recovery-render-source-v1"),
    stem: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    articleHtml: z.string().min(1).max(2_000_000),
    metadata: z
      .object({
        planId: IDENTIFIER,
        userId: IDENTIFIER,
        businessId: IDENTIFIER,
        keyword: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        seoTitle: z.string().trim().min(1).max(200),
        slug: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        metaDescription: z.string().trim().min(1).max(500),
        excerpt: z.string().max(2_000),
        author: z.string().trim().min(1).max(200),
        categories: z.array(LIST_ITEM).max(20),
        tags: z.array(LIST_ITEM).max(50),
        secondaryKeywords: z.array(LIST_ITEM).max(49).default([]),
        generationAuthorized: z.literal(true),
        publicationAuthorized: z.literal(false),
        importAuthorized: z.literal(false),
      })
      .passthrough(),
    provenance: z
      .object({
        recoveryBatchId: IDENTIFIER,
        sourceArtifacts: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
        firstPartyUrls: z.array(URL).max(25),
        officialTechnicalUrls: z.array(URL).max(25),
      })
      .passthrough(),
    validation: z
      .object({
        status: z.literal(
          "local_review_candidate_blocked_from_publication_and_import",
        ),
        summary: z
          .object({
            pass: z.number().int().min(1),
            warning: z.number().int().min(0),
            fail: z.literal(0),
          })
          .strict(),
        checks: z
          .array(
            z
              .object({
                id: IDENTIFIER,
                status: z.enum(["pass", "warning"]),
                detail: z.string().trim().min(1).max(2_000),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        publicationAuthorized: z.literal(false),
        importAuthorized: z.literal(false),
      })
      .passthrough(),
    databasePayload: z
      .object({
        provenance: z
          .object({
            researchRetrievedAt: z.iso.datetime(),
            researchArtifactId: z.string().trim().min(1).max(300),
          })
          .passthrough(),
        blog: z
          .object({
            custom_fields: z
              .object({
                reading_time: z.string().trim().min(1).max(80),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const PLAN_SNAPSHOT_ITEM = z
  .object({
    id: IDENTIFIER,
    userId: IDENTIFIER,
    businessId: IDENTIFIER,
    keyword: z.string().trim().min(1).max(200),
    publishDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    publishTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    blogId: z.null(),
    isUsed: z.literal(false),
    usedAt: z.null(),
    deletedAt: z.null(),
    business: z
      .object({
        businessWebsiteUrl: z.url(),
      })
      .passthrough(),
  })
  .passthrough();

export const RECOVERY_READ_ONLY_PLAN_SNAPSHOT = z
  .object({
    queryMode: z.literal("production_read_only"),
    capturedAt: z.iso.datetime(),
    safety: z
      .object({
        writesPerformed: z.literal(0),
      })
      .passthrough(),
    plans: z.array(PLAN_SNAPSHOT_ITEM).min(1).max(100),
  })
  .passthrough();

const ASSEMBLY_OPTIONS = z
  .object({
    scope: z.literal("isolated-development-only"),
    productionAuthorized: z.literal(false),
    approvedBy: z.string().trim().min(1).max(140),
    now: z.date(),
    manifestTtlMinutes: z.number().int().min(5).max(60).default(30),
  })
  .strict();

const PRODUCTION_CANARY_OPTIONS = z
  .object({
    scope: z.literal("production-canary-draft-only"),
    productionAuthorized: z.literal(true),
    publicationAuthorized: z.literal(false),
    approval: z.literal("APPROVE_PRODUCTION_CANARY"),
    approvedBy: z.string().trim().min(1).max(140),
    approvedArticleSha256: z.string().regex(/^[a-f0-9]{64}$/),
    now: z.date(),
    maximumSnapshotAgeMinutes: z.number().int().min(1).max(10).default(5),
    manifestTtlMinutes: z.number().int().min(5).max(15).default(10),
  })
  .strict();

export type IsolatedRecoveryAssembly = {
  package: RecoveryDraftPackage;
  manifest: RecoveryApprovedManifest;
  receipt: {
    schemaVersion: 1;
    scope: "isolated-development-only";
    productionAuthorized: false;
    publicationAuthorized: false;
    databaseWritesPerformed: 0;
    sourceStem: string;
    sourcePublicationStatus: string;
    sourceSnapshotCapturedAt: string;
    packageDigest: string;
    manifestExpiresAt: string;
    omissions: {
      canonical: "omitted_unverified";
      featuredMedia: "empty_unverified";
      structuredData: "omitted_unverified";
      seoScore: "omitted_unverified";
    };
  };
};

export type ProductionCanaryRecoveryAssembly = {
  package: RecoveryDraftPackage;
  manifest: RecoveryApprovedManifest;
  receipt: {
    schemaVersion: 1;
    scope: "production-canary-draft-only";
    approval: "APPROVE_PRODUCTION_CANARY";
    productionAuthorized: true;
    publicationAuthorized: false;
    databaseWritesPerformed: 0;
    sourceStem: string;
    sourceSnapshotCapturedAt: string;
    approvedArticleSha256: string;
    packageDigest: string;
    manifestExpiresAt: string;
    exactProposedMutation: {
      blogRowsCreated: 1;
      planRowsLinked: 1;
      forcedStatus: "DRAFT";
      publishingSideEffects: 0;
    };
    omissions: {
      canonical: "omitted_unverified";
      featuredMedia: "empty_public_host_unavailable";
      structuredData: "omitted_until_publication";
      seoScore: "omitted_unapproved";
    };
  };
};

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function assembleIsolatedRecoveryCandidate(input: {
  editorialSource: unknown;
  planSnapshot: unknown;
  options: unknown;
}): IsolatedRecoveryAssembly {
  const source = ISOLATED_EDITORIAL_SOURCE.parse(input.editorialSource);
  const snapshot = RECOVERY_READ_ONLY_PLAN_SNAPSHOT.parse(input.planSnapshot);
  const options = ASSEMBLY_OPTIONS.parse(input.options);
  if (!Number.isFinite(options.now.getTime())) {
    throw new Error("Assembly time must be valid");
  }

  const plan = snapshot.plans.find(
    (candidate) => candidate.id === source.metadata.planId,
  );
  if (!plan) {
    throw new Error("Approved editorial Plan is missing from the read-only snapshot");
  }
  if (
    plan.userId !== source.metadata.userId ||
    plan.businessId !== source.metadata.businessId ||
    normalized(plan.keyword) !== normalized(source.metadata.keyword)
  ) {
    throw new Error("Editorial identity does not match the read-only Plan snapshot");
  }

  const sourceUrls = [
    ...new Set([
      ...source.provenance.firstPartyUrls,
      ...source.provenance.officialTechnicalUrls,
    ]),
  ];
  if (sourceUrls.length === 0) {
    throw new Error("At least one HTTP(S) editorial source URL is required");
  }

  const packageId = `isolated-development-${source.stem}`;
  const batchId = `isolated-development-${source.provenance.recoveryBatchId}`;
  const validatorVersion = "isolated-editorial-assembly-v1";
  const assembled = RECOVERY_DRAFT_PACKAGE.parse({
    schemaVersion: 1,
    packageId,
    batchId,
    planId: source.metadata.planId,
    userId: source.metadata.userId,
    businessId: source.metadata.businessId,
    route: {
      action: "create_blog",
      intentFingerprint: `${source.metadata.businessId}:${source.metadata.slug}`,
      rationale:
        "Editorial body approved for an isolated development importer exercise only; publication, canonical, media, schema, and production import remain unauthorized.",
    },
    validation: {
      status: "approved",
      validatorVersion,
      validatedAt: options.now.toISOString(),
      blockers: [],
      warnings: [
        "ISOLATED DEVELOPMENT ONLY. This package is not production or publication approval.",
        "Canonical, featured media, structured data, and SEO score were omitted because final values are unverified.",
        "The organization author is provisional; the importer must prefer an approved Business author when available.",
        "The Plan schedule and unused state come from a read-only snapshot and must be rechecked by the importer transaction.",
        "CustomField rating is 0 to represent unrated content, not a public review score.",
      ],
    },
    provenance: {
      engineVersion: "recovery-assembler-isolated-development-v1",
      sourceUrls,
      researchRetrievedAt:
        source.databasePayload.provenance.researchRetrievedAt,
      researchArtifactId:
        source.databasePayload.provenance.researchArtifactId,
    },
    blog: {
      businessId: source.metadata.businessId,
      title: source.metadata.title,
      slug: source.metadata.slug,
      status: "DRAFT",
      author: source.metadata.author,
      content: source.articleHtml,
      excerpt: source.metadata.excerpt,
      categories: source.metadata.categories,
      tags: source.metadata.tags,
      featured_media: "",
      meta: {
        seo_title: source.metadata.seoTitle,
        seo_description: source.metadata.metaDescription,
        focus_keyword: source.metadata.keyword,
        keywords: [
          ...new Set([
            source.metadata.keyword,
            ...source.metadata.secondaryKeywords,
          ]),
        ],
      },
      custom_fields: {
        reading_time:
          source.databasePayload.blog.custom_fields.reading_time,
        rating: 0,
      },
      blogPublishInfo: {
        date: plan.publishDate,
        time: plan.publishTime,
      },
    },
  });
  const packageDigest = computeRecoveryPackageDigest(assembled);
  const expiresAt = new Date(
    options.now.getTime() + options.manifestTtlMinutes * 60_000,
  );
  const approvedBusinessHost = new globalThis.URL(
    plan.business.businessWebsiteUrl,
  ).hostname.toLocaleLowerCase();
  const manifest = RECOVERY_APPROVED_MANIFEST.parse({
    schemaVersion: 1,
    manifestId: `isolated-development-manifest-${source.stem}`,
    batchId,
    mode: "canary",
    generatedAt: options.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    approval: {
      status: "approved",
      approvedAt: options.now.toISOString(),
      approvedBy: `ISOLATED DEVELOPMENT ONLY — ${options.approvedBy}`,
    },
    entries: [
      {
        packageId,
        planId: source.metadata.planId,
        userId: source.metadata.userId,
        businessId: source.metadata.businessId,
        route: "CREATE",
        generationAuthorized: true,
        validation: {
          status: "approved",
          blockers: [],
          validatorVersion,
        },
        approvedBusinessHost,
        approvedCanonicalUrl: null,
        packageDigest,
      },
    ],
  });

  return {
    package: assembled,
    manifest,
    receipt: {
      schemaVersion: 1,
      scope: options.scope,
      productionAuthorized: false,
      publicationAuthorized: false,
      databaseWritesPerformed: 0,
      sourceStem: source.stem,
      sourcePublicationStatus: source.validation.status,
      sourceSnapshotCapturedAt: snapshot.capturedAt,
      packageDigest,
      manifestExpiresAt: expiresAt.toISOString(),
      omissions: {
        canonical: "omitted_unverified",
        featuredMedia: "empty_unverified",
        structuredData: "omitted_unverified",
        seoScore: "omitted_unverified",
      },
    },
  };
}

export function assembleProductionRecoveryCanary(input: {
  editorialSource: unknown;
  planSnapshot: unknown;
  options: unknown;
}): ProductionCanaryRecoveryAssembly {
  const source = ISOLATED_EDITORIAL_SOURCE.parse(input.editorialSource);
  const snapshot = RECOVERY_READ_ONLY_PLAN_SNAPSHOT.parse(input.planSnapshot);
  const options = PRODUCTION_CANARY_OPTIONS.parse(input.options);
  if (!Number.isFinite(options.now.getTime())) {
    throw new Error("Assembly time must be valid");
  }

  const capturedAt = new Date(snapshot.capturedAt);
  const snapshotAgeMs = options.now.getTime() - capturedAt.getTime();
  if (snapshotAgeMs < 0 || snapshotAgeMs > options.maximumSnapshotAgeMinutes * 60_000) {
    throw new Error("Production canary requires a fresh read-only Plan snapshot");
  }

  const articleSha256 = createHash("sha256")
    .update(source.articleHtml)
    .digest("hex");
  if (articleSha256 !== options.approvedArticleSha256) {
    throw new Error("Editorial article hash does not match the approved canary");
  }

  const isolated = assembleIsolatedRecoveryCandidate({
    editorialSource: source,
    planSnapshot: snapshot,
    options: {
      scope: "isolated-development-only",
      productionAuthorized: false,
      approvedBy: "Production canary transformation prerequisite",
      now: options.now,
      manifestTtlMinutes: options.manifestTtlMinutes,
    },
  });

  const packageId = `production-canary-${source.stem}`;
  const batchId = `production-canary-${source.provenance.recoveryBatchId}`;
  const validatorVersion = "production-canary-draft-assembly-v1";
  const canaryPackage = RECOVERY_DRAFT_PACKAGE.parse({
    ...isolated.package,
    packageId,
    batchId,
    route: {
      ...isolated.package.route,
      rationale:
        "Editorial and claims review passed for one controlled production DRAFT canary. Public canonical, media, schema, author, dates, and publication remain withheld; this package must not publish or notify externally.",
    },
    validation: {
      status: "approved",
      validatorVersion,
      validatedAt: options.now.toISOString(),
      blockers: [],
      warnings: [
        "DRAFT CANARY ONLY. Public publication is not authorized.",
        "Canonical and structured data are intentionally omitted until the live route and publication identity are final.",
        "Featured media is empty because the configured image storage rejected the controlled upload before persistence.",
        "The importer must re-read ownership, subscription, Plan state, duplicates, and business host inside the transaction.",
      ],
    },
    provenance: {
      ...isolated.package.provenance,
      engineVersion: "recovery-production-canary-assembler-v1",
    },
  });
  const packageDigest = computeRecoveryPackageDigest(canaryPackage);
  const expiresAt = new Date(
    options.now.getTime() + options.manifestTtlMinutes * 60_000,
  );
  const approvedBusinessHost = isolated.manifest.entries[0]
    ?.approvedBusinessHost;
  if (!approvedBusinessHost) {
    throw new Error("Approved business host is missing from the Plan snapshot");
  }
  const manifest = RECOVERY_APPROVED_MANIFEST.parse({
    schemaVersion: 1,
    manifestId: `production-canary-manifest-${source.stem}`,
    batchId,
    mode: "canary",
    generatedAt: options.now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    approval: {
      status: "approved",
      approvedAt: options.now.toISOString(),
      approvedBy: `${options.approvedBy} — APPROVE_PRODUCTION_CANARY`,
    },
    entries: [
      {
        packageId,
        planId: source.metadata.planId,
        userId: source.metadata.userId,
        businessId: source.metadata.businessId,
        route: "CREATE",
        generationAuthorized: true,
        validation: {
          status: "approved",
          blockers: [],
          validatorVersion,
        },
        approvedBusinessHost,
        approvedCanonicalUrl: null,
        packageDigest,
      },
    ],
  });

  return {
    package: canaryPackage,
    manifest,
    receipt: {
      schemaVersion: 1,
      scope: options.scope,
      approval: options.approval,
      productionAuthorized: true,
      publicationAuthorized: false,
      databaseWritesPerformed: 0,
      sourceStem: source.stem,
      sourceSnapshotCapturedAt: snapshot.capturedAt,
      approvedArticleSha256: articleSha256,
      packageDigest,
      manifestExpiresAt: expiresAt.toISOString(),
      exactProposedMutation: {
        blogRowsCreated: 1,
        planRowsLinked: 1,
        forcedStatus: "DRAFT",
        publishingSideEffects: 0,
      },
      omissions: {
        canonical: "omitted_unverified",
        featuredMedia: "empty_public_host_unavailable",
        structuredData: "omitted_until_publication",
        seoScore: "omitted_unapproved",
      },
    },
  };
}
