import type { Prisma, PrismaClient } from "@prisma/client";
import { inspect } from "util";
import { z } from "zod";
import { createPrismaClient, prisma } from "../config/db.config";
import { upsertBusinessProfile } from "../config/pinecone.config";
import type { AgencyAssignment } from "../utils/agency-context.utils";
import { getUpliftDirectAgency } from "../utils/agency-context.utils";
import {
  extractDesignInfoFromPayload,
  mapWebsiteAnalysisToBusiness,
} from "../utils/business-mapper.utils";
import {
  getEquivalentWebsiteUrls,
  normalizeWebsiteUrl,
} from "../utils/url-normalizer";
import { saveWebsiteAnalysis } from "../utils/website-analysis.utils";
import {
  getPrismaErrorMessage,
  runWithTransientPrismaRetry,
} from "../utils/prisma-resilience.utils";
import {
  isBlockedAdultWebsiteUrl,
  UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE,
} from "../utils/adult-domain-blocklist.utils";
import { ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION } from "../utils/brand-analysis-status.utils";
import {
  WEBSITE_ANALYSIS,
  normalizeOptionalEmail,
} from "../validators/business.validation";
import type { BusinessOnboardingFlow } from "./onboarding-state.service";

type WebsiteAnalysisPayload = z.infer<typeof WEBSITE_ANALYSIS>;

type PersistDefaults = {
  websiteStatus: string;
  isActive?: boolean;
  isPrimary?: boolean;
};

export type PersistAnalyzedBusinessInput = {
  rawWebsiteAnalysis: unknown;
  userId: string;
  preferredBusinessId?: string | null;
  agencyAssignment?: AgencyAssignment;
  onboardingFlow?: BusinessOnboardingFlow | null;
  correlationId?: string | null;
  createDefaults?: PersistDefaults;
};

export type PersistAnalyzedBusinessResult = {
  businessId: string;
  websiteAnalysisId: string | null;
  normalizedUrl: string;
};

export class OnboardingPersistenceError extends Error {
  code: string;
  stage: string;
  details?: unknown;

  constructor(args: {
    code: string;
    stage: string;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(args.message, args.cause ? { cause: args.cause } : undefined);
    this.name = "OnboardingPersistenceError";
    this.code = args.code;
    this.stage = args.stage;
    this.details = args.details;
  }
}

function formatValidationError(error: z.ZodError): string {
  const fieldErrors = error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return fieldErrors || "Unknown validation error";
}

function normalizeKeywordList(keywords: string[]): string[] {
  const normalized = keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeAnalysisContactEmail(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = { ...(value as Record<string, unknown>) };
  const contactInfo =
    record.contactInfo &&
    typeof record.contactInfo === "object" &&
    !Array.isArray(record.contactInfo)
      ? { ...(record.contactInfo as Record<string, unknown>) }
      : null;

  if (!contactInfo || !("email" in contactInfo)) {
    return record;
  }

  const normalizedEmail = normalizeOptionalEmail(contactInfo.email);
  if (normalizedEmail) {
    contactInfo.email = normalizedEmail;
  } else {
    delete contactInfo.email;
  }

  record.contactInfo = contactInfo;
  return record;
}

export function normalizeWebsiteAnalysisForPersistence(
  structuredJson: unknown,
  userId: string,
): WebsiteAnalysisPayload {
  const parsedWebsiteAnalysis = WEBSITE_ANALYSIS.safeParse(
    normalizeAnalysisContactEmail(structuredJson),
  );
  if (!parsedWebsiteAnalysis.success) {
    throw new OnboardingPersistenceError({
      code: "analysis_validation_failed",
      stage: "validate_analysis",
      message: `WEBSITE_ANALYSIS invalid before persistence. ${formatValidationError(
        parsedWebsiteAnalysis.error,
      )}`,
      details: parsedWebsiteAnalysis.error.flatten(),
    });
  }

  const websiteAnalysis = parsedWebsiteAnalysis.data;
  const seo = websiteAnalysis.seo ?? {};
  const fromTargetKeywords = Array.isArray(seo.targetKeywords)
    ? seo.targetKeywords
    : [];
  const fromKeywords = Array.isArray(seo.keywords) ? seo.keywords : [];
  const fromTypedKeywords = Array.isArray(seo.targetKeywordsWithType)
    ? seo.targetKeywordsWithType.map((keyword) => keyword.keyword)
    : [];

  const normalizedKeywords = normalizeKeywordList([
    ...fromTargetKeywords,
    ...fromKeywords,
    ...fromTypedKeywords,
  ]);

  const normalizedTypedKeywords =
    Array.isArray(seo.targetKeywordsWithType) &&
    seo.targetKeywordsWithType.length > 0
      ? seo.targetKeywordsWithType
          .map((keyword) => ({
            keyword: keyword.keyword.trim(),
            keywordType: keyword.keywordType,
          }))
          .filter((keyword) => keyword.keyword.length > 0)
      : normalizedKeywords.slice(0, 30).map((keyword, index) => ({
          keyword,
          keywordType: index < 10 ? ("MUST_HAVE" as const) : ("NICE_TO_HAVE" as const),
        }));

  const normalizedAnalysis = {
    ...websiteAnalysis,
    userId,
    seo: {
      ...seo,
      targetKeywords: normalizedKeywords,
      keywords: normalizedKeywords,
      targetKeywordsWithType: normalizedTypedKeywords,
    },
  } satisfies WebsiteAnalysisPayload;

  const validatedNormalizedPayload = WEBSITE_ANALYSIS.safeParse(normalizedAnalysis);
  if (!validatedNormalizedPayload.success) {
    throw new OnboardingPersistenceError({
      code: "analysis_validation_failed",
      stage: "normalize_analysis",
      message: `Normalized WEBSITE_ANALYSIS invalid. ${formatValidationError(
        validatedNormalizedPayload.error,
      )}`,
      details: validatedNormalizedPayload.error.flatten(),
    });
  }

  if ((normalizedAnalysis.seo?.targetKeywords ?? []).length < 1) {
    throw new OnboardingPersistenceError({
      code: "analysis_validation_failed",
      stage: "normalize_analysis",
      message: "seo.targetKeywords must contain at least one keyword.",
    });
  }

  return validatedNormalizedPayload.data;
}

async function resolveFallbackAgencyAssignment(): Promise<AgencyAssignment> {
  const upliftDirect = await getUpliftDirectAgency();
  if (!upliftDirect) {
    return {
      agencyId: null,
      agencySlug: null,
      ownershipType: "uplift_direct",
    };
  }

  return {
    agencyId: upliftDirect.id,
    agencySlug: upliftDirect.slug,
    ownershipType: "uplift_direct",
  };
}

function serializeJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function disconnectRetryPrismaClient(
  dbClient: PrismaClient,
  operationName: string,
): Promise<void> {
  try {
    await dbClient.$disconnect();
  } catch (error) {
    console.warn(
      `[OnboardingPersistence] Failed to disconnect retry Prisma client for ${operationName}:`,
      inspect(
        {
          message: getPrismaErrorMessage(error),
        },
        { depth: null, colors: true },
      ),
    );
  }
}

export async function persistAnalyzedBusiness(
  input: PersistAnalyzedBusinessInput,
): Promise<PersistAnalyzedBusinessResult> {
  const normalizedAnalysis = normalizeWebsiteAnalysisForPersistence(
    input.rawWebsiteAnalysis,
    input.userId,
  );

  console.log(
    "[OnboardingPersistence] Normalized website analysis:",
    inspect(
      {
        userId: normalizedAnalysis.userId,
        scrapedUrl: normalizedAnalysis.scrapedUrl,
        domain: normalizedAnalysis.domain,
        keywordCount: normalizedAnalysis.seo?.targetKeywords?.length ?? 0,
      },
      { depth: null, colors: true },
    ),
  );

  let mappedPayload: Awaited<ReturnType<typeof mapWebsiteAnalysisToBusiness>>;
  try {
    mappedPayload = await mapWebsiteAnalysisToBusiness(
      normalizedAnalysis,
      input.userId,
    );
  } catch (error) {
    throw new OnboardingPersistenceError({
      code: "analysis_mapping_failed",
      stage: "map_analysis",
      message: "Failed to map website analysis to business payload.",
      details:
        error instanceof Error
          ? { message: error.message, cause: error.cause }
          : { error: String(error) },
      cause: error,
    });
  }

  const normalizedUrl =
    normalizeWebsiteUrl(mappedPayload.websiteURL ?? "") || mappedPayload.websiteURL;
  if (isBlockedAdultWebsiteUrl(normalizedUrl)) {
    throw new OnboardingPersistenceError({
      code: "unsupported_website_category",
      stage: "validate_url",
      message: UNSUPPORTED_WEBSITE_CATEGORY_MESSAGE,
    });
  }

  const websiteUrlCandidates = getEquivalentWebsiteUrls(normalizedUrl);

  const fallbackAgencyAssignment =
    input.agencyAssignment ?? (await resolveFallbackAgencyAssignment());

  try {
    const persisted = await runWithTransientPrismaRetry(
      async (attempt) => {
        const dbClient = createPrismaClient();

        try {
          await dbClient.$connect();

          return await dbClient.$transaction(async (tx) => {
            const preferredBusiness = input.preferredBusinessId
              ? await tx.business.findFirst({
                  where: { id: input.preferredBusinessId, userId: input.userId },
                  select: {
                    id: true,
                    agencyId: true,
                    ownershipType: true,
                    onboardedByUserId: true,
                    onboardingFlow: true,
                    onboardingStatus: true,
                  },
                })
              : null;

            const existingBusiness =
              preferredBusiness ??
              (await tx.business.findFirst({
                where: {
                  userId: input.userId,
                  businessWebsiteUrl: { in: websiteUrlCandidates },
                },
                orderBy: { createdAt: "desc" },
                select: {
                  id: true,
                  agencyId: true,
                  ownershipType: true,
                  onboardedByUserId: true,
                  onboardingFlow: true,
                  onboardingStatus: true,
                },
              }));

            const existingBusinesses = await tx.business.findMany({
              where: { userId: input.userId },
              select: { id: true },
            });

            const isFirstBusiness =
              existingBusinesses.length === 0 ||
              (existingBusinesses.length === 1 && existingBusiness !== null);

            const nextOnboardingFlow =
              input.onboardingFlow ??
              ((existingBusiness?.onboardingFlow as BusinessOnboardingFlow | null | undefined) ??
                undefined);

            const commonBusinessData = {
              businessName: mappedPayload.businessName,
              businessDescription: mappedPayload.businessDescription,
              businessType: mappedPayload.businessType,
              businessAddress: mappedPayload.businessAddress,
              businessCity: mappedPayload.businessCity,
              businessState: mappedPayload.businessState,
              businessCountry: mappedPayload.businessCountry,
              serviceArea: mappedPayload.serviceArea,
              targetAudience: mappedPayload.targetAudience,
              contentTone: mappedPayload.contentTone,
              publishingFrequency: mappedPayload.publishingFrequency,
              publishDaysOfWeek:
                mappedPayload.publishDaysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
              preferredContentTypes: mappedPayload.preferredContentTypes || [],
              onboardingFlow: nextOnboardingFlow,
              onboardingCorrelationId: input.correlationId ?? undefined,
            };

            const business = existingBusiness
              ? await tx.business.update({
                  where: { id: existingBusiness.id },
                  data: {
                    ...commonBusinessData,
                    agencyId:
                      existingBusiness.agencyId ??
                      fallbackAgencyAssignment.agencyId,
                    ownershipType:
                      existingBusiness.agencyId != null
                        ? existingBusiness.ownershipType === "agency_managed"
                          ? "agency_managed"
                          : "uplift_direct"
                        : fallbackAgencyAssignment.ownershipType,
                    onboardedByUserId:
                      existingBusiness.onboardedByUserId ?? input.userId,
                  },
                })
              : await tx.business.create({
                  data: {
                    ...commonBusinessData,
                    userId: input.userId,
                    businessWebsiteUrl: normalizedUrl || mappedPayload.websiteURL,
                    isActive: input.createDefaults?.isActive ?? true,
                    isPrimary: input.createDefaults?.isPrimary ?? isFirstBusiness,
                    websiteStatus: input.createDefaults?.websiteStatus ?? "active",
                    agencyId: fallbackAgencyAssignment.agencyId,
                    ownershipType: fallbackAgencyAssignment.ownershipType,
                    onboardedByUserId: input.userId,
                  },
                });

            await tx.keywords.deleteMany({
              where: { businessId: business.id },
            });
            await tx.competitiveAdvantage.deleteMany({
              where: { businessId: business.id },
            });
            await tx.competitors.deleteMany({
              where: { businessId: business.id },
            });
            await tx.currentRanking.deleteMany({
              where: { businessId: business.id },
            });

            await tx.keywords.createMany({
              data: mappedPayload.keywords.map((keyword) => ({
                keyword: keyword.keyword,
                keywordType: keyword.keywordType,
                businessId: business.id,
              })),
            });

            await tx.competitiveAdvantage.create({
              data: {
                businessId: business.id,
                advantage: mappedPayload.advantage,
              },
            });

            if (mappedPayload.competitors.length > 0) {
              await tx.competitors.createMany({
                data: mappedPayload.competitors.map((competitor) => ({
                  name: competitor.name,
                  url: competitor.url,
                  businessId: business.id,
                })),
              });
            }

            await tx.currentRanking.create({
              data: {
                ranking: mappedPayload.ranking,
                website: mappedPayload.website,
                businessId: business.id,
              },
            });

            const websiteAnalysis = await saveWebsiteAnalysis(
              tx,
              normalizedAnalysis,
              business.id,
            );

            return {
              businessId: business.id,
              websiteAnalysisId: websiteAnalysis.id,
              mappedPayload,
              normalizedAnalysis,
            };
          }, { timeout: 30000 });
        } finally {
          await disconnectRetryPrismaClient(
            dbClient,
            `persistAnalyzedBusiness attempt ${attempt}`,
          );
        }
      },
      {
        operationName: "persistAnalyzedBusiness",
        maxAttempts: 3,
        retryDelayMs: 300,
        onRetry: ({ attempt, nextAttempt, error }) => {
          console.warn(
            "[OnboardingPersistence] Transient Prisma connection error during persistence; retrying with a fresh Prisma client.",
            inspect(
              {
                attempt,
                nextAttempt,
                userId: input.userId,
                preferredBusinessId: input.preferredBusinessId ?? null,
                normalizedUrl,
                message: getPrismaErrorMessage(error),
              },
              { depth: null, colors: true },
            ),
          );
        },
      },
    );

    const designInfo = {
      colors: persisted.normalizedAnalysis.design?.colors || [],
      fonts: persisted.normalizedAnalysis.design?.fonts || [],
      logos: persisted.normalizedAnalysis.brandIdentity?.logos || [],
      favicon: persisted.normalizedAnalysis.brandIdentity?.favicon,
    };

    void (async () => {
      try {
        await upsertBusinessProfile(
          persisted.businessId,
          {
            businessDescription: persisted.mappedPayload.businessDescription,
            businessType: persisted.mappedPayload.businessType,
            advantage: persisted.mappedPayload.advantage,
            keywords: persisted.mappedPayload.keywords,
            userId: input.userId,
            websiteURL: persisted.mappedPayload.websiteURL,
            competitors: persisted.mappedPayload.competitors,
          },
          persisted.mappedPayload.businessName,
        );
      } catch (error) {
        console.error(
          "❌ Failed to upsert business profile to Pinecone (continuing anyway):",
          error,
        );
      }

      try {
        const designData = extractDesignInfoFromPayload(designInfo);
        await prisma.brandAnalysis.upsert({
          where: { businessId: persisted.businessId },
          create: {
            businessId: persisted.businessId,
            ...designData,
            lastAnalyzed: new Date(),
            analysisVersion: ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION,
          },
          update: {
            ...designData,
            lastAnalyzed: new Date(),
            analysisVersion: ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION,
          },
        });
      } catch (error) {
        console.error("❌ Failed to save brand analysis:", error);
      }

      if (persisted.mappedPayload.websiteURL?.trim()) {
        try {
          const { inngest } = await import("../inngest/client");
          await inngest.send({
            name: "brand/analyze",
            data: {
              businessId: persisted.businessId,
              websiteUrl: persisted.mappedPayload.websiteURL,
              userId: input.userId,
              forceRefresh: true,
              source: "onboarding_persistence",
            },
          });
        } catch (error) {
          console.error("❌ Failed to trigger brand analysis:", error);
        }
      }
    })();

    return {
      businessId: persisted.businessId,
      websiteAnalysisId: persisted.websiteAnalysisId,
      normalizedUrl,
    };
  } catch (error) {
    if (error instanceof OnboardingPersistenceError) {
      throw error;
    }

    throw new OnboardingPersistenceError({
      code: "business_persist_failed",
      stage: "persist_business",
      message: "Failed to persist analyzed business.",
      details: serializeJson(
        error instanceof Error
          ? { message: error.message, cause: error.cause }
          : { error: String(error) },
      ),
      cause: error,
    });
  }
}
