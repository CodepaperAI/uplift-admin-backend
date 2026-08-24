import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { inspect } from "util";
import z from "zod";
import {
  OnboardingPersistenceError,
  type PersistAnalyzedBusinessResult,
  persistAnalyzedBusiness,
} from "../services/onboarding-persistence.service";
import type { BusinessOnboardingFlow } from "../services/onboarding-state.service";
import {
  buildOnboardingWebsiteInfoPayload,
  OnboardingScrapeError,
  scrapeWebsiteForOnboarding,
  type OnboardingScrapeSnapshot,
} from "../utils/onboarding-scrape.utils";
import { normalizeWebsiteUrl } from "../utils/url-normalizer";
import {
  WEBSITE_ANALYSIS,
  normalizeOptionalEmail,
} from "../validators/business.validation";

interface GetWebsiteDataParams {
  chunk?: number | null;
}

export const ONBOARDING_LLM_SUCCESS_PREFIX = "TASK_COMPLETE:";
export const ONBOARDING_LLM_FAILURE_PREFIX = "TASK_FAILED_NON_RETRYABLE:";

type WebsiteAnalysisPayload = z.infer<typeof WEBSITE_ANALYSIS>;

export type OnboardingToolContext = {
  userId: string;
  websiteUrl: string;
  correlationId?: string | null;
  onboardingFlow?: BusinessOnboardingFlow | null;
  preferredBusinessId?: string | null;
};

type OnboardingFailureLike = {
  code: string;
  stage: string;
  message: string;
  details?: unknown;
};

type OnboardingScrapeCache = Map<string, OnboardingScrapeSnapshot>;
type ToolCallLike = {
  name?: string;
  args?: unknown;
};

const persistedBusinessResultSchema = z.object({
  businessId: z.string(),
  websiteAnalysisId: z.string().nullable(),
  normalizedUrl: z.string().min(1),
});

const onboardingFailureResultSchema = z.object({
  code: z.string().min(1),
  stage: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().nullable(),
});

function describeLike<T extends z.ZodTypeAny>(
  schema: T,
  description?: string | undefined,
): T {
  return description ? (schema.describe(description) as T) : schema;
}

function unwrapToolSchema(schema: z.ZodTypeAny): {
  schema: z.ZodTypeAny;
  nullable: boolean;
} {
  let currentSchema = schema;
  let nullable = false;

  while (
    currentSchema instanceof z.ZodOptional ||
    currentSchema instanceof z.ZodNullable
  ) {
    nullable = true;
    currentSchema = currentSchema.unwrap() as z.ZodTypeAny;
  }

  return { schema: currentSchema, nullable };
}

function makeOpenAICompatibleToolSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const { schema: unwrappedSchema, nullable } = unwrapToolSchema(schema);
  let converted: z.ZodTypeAny;

  if (unwrappedSchema instanceof z.ZodString) {
    converted = z.string();
  } else if (unwrappedSchema instanceof z.ZodObject) {
    const convertedShape = Object.fromEntries(
      Object.entries(unwrappedSchema.shape).map(([key, value]) => [
        key,
        makeOpenAICompatibleToolSchema(value as z.ZodTypeAny),
      ]),
    );
    converted = z.object(convertedShape);
  } else if (unwrappedSchema instanceof z.ZodArray) {
    converted = z.array(
      makeOpenAICompatibleToolSchema(unwrappedSchema.element as z.ZodTypeAny),
    );
  } else if (unwrappedSchema instanceof z.ZodEnum) {
    const enumOptions = unwrappedSchema.options.filter(
      (option): option is string => typeof option === "string",
    );
    converted =
      enumOptions.length > 0
        ? z.enum(enumOptions as [string, ...string[]])
        : z.string();
  } else if (unwrappedSchema instanceof z.ZodLiteral) {
    converted = z.literal(unwrappedSchema.value);
  } else if (unwrappedSchema instanceof z.ZodBoolean) {
    converted = z.boolean();
  } else if (unwrappedSchema instanceof z.ZodNumber) {
    converted = z.number();
  } else if (unwrappedSchema instanceof z.ZodRecord) {
    converted = z.record(
      z.string(),
      makeOpenAICompatibleToolSchema(
        (unwrappedSchema as z.ZodRecord).valueType as z.ZodTypeAny,
      ),
    );
  } else if (
    unwrappedSchema instanceof z.ZodAny ||
    unwrappedSchema instanceof z.ZodUnknown
  ) {
    // z.any() / z.unknown() produce schemas without a "type" key,
    // which OpenAI rejects. Fall back to a permissive object type.
    converted = z.record(z.string(), z.string());
  } else if (unwrappedSchema instanceof z.ZodUnion) {
    const unionOptions = unwrappedSchema.options as unknown as z.ZodTypeAny[];
    converted = z.union(
      unionOptions.map((option) =>
        makeOpenAICompatibleToolSchema(option),
      ) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
    );
  } else {
    converted = z.any();
  }

  const described = describeLike(converted, unwrappedSchema.description);
  return nullable ? described.nullable() : described;
}

const baseSaveBusinessDataToolSchema = (
  makeOpenAICompatibleToolSchema(WEBSITE_ANALYSIS) as z.ZodObject<
    Record<string, z.ZodTypeAny>
  >
);

const baseSaveBusinessDataToolShape = baseSaveBusinessDataToolSchema.shape as Record<
  string,
  z.ZodTypeAny | undefined
>;
const convertedSeoToolSchema = unwrapToolSchema(
  baseSaveBusinessDataToolShape.seo ?? z.object({}),
).schema as z.ZodObject<Record<string, z.ZodTypeAny>>;

export const saveBusinessDataToolSchema = baseSaveBusinessDataToolSchema
  .extend({
    seo: convertedSeoToolSchema
      .extend({
        openGraph: z
          .string()
          .nullable()
          .describe(
            "Open Graph metadata as a serialized JSON object string, or null if unavailable.",
          ),
        twitterCard: z
          .string()
          .nullable()
          .describe(
            "Twitter card metadata as a serialized JSON object string, or null if unavailable.",
          ),
        schema: z
          .array(z.string())
          .nullable()
          .describe(
            "JSON-LD schema blocks as serialized JSON strings, or null if unavailable.",
          ),
        verification: z
          .string()
          .nullable()
          .describe(
            "Verification metadata as a serialized JSON object string, or null if unavailable.",
          ),
      })
      .nullable(),
  })
  .omit({
    userId: true,
  });

function getTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return (item as { text: string }).text;
        }

        return "";
      })
      .join(" ");
  }

  return "";
}

function normalizeWebsiteAnalysisCandidate(
  value: unknown,
  userId: string,
): unknown {
  function safeParseJson(valueToParse: string): unknown {
    try {
      return JSON.parse(valueToParse);
    } catch {
      return undefined;
    }
  }

  function normalizeStringRecord(valueToNormalize: unknown): Record<string, string> | undefined {
    const parsedValue =
      typeof valueToNormalize === "string"
        ? safeParseJson(valueToNormalize.trim())
        : valueToNormalize;

    if (
      !parsedValue ||
      typeof parsedValue !== "object" ||
      Array.isArray(parsedValue)
    ) {
      return undefined;
    }

    const normalizedEntries = Object.entries(
      parsedValue as Record<string, unknown>,
    )
      .map(([key, entryValue]) => {
        if (entryValue === null || entryValue === undefined) {
          return null;
        }

        return [
          key,
          typeof entryValue === "string"
            ? entryValue
            : JSON.stringify(entryValue),
        ] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null);

    return normalizedEntries.length > 0
      ? Object.fromEntries(normalizedEntries)
      : undefined;
  }

  function normalizeSeoSchemaArray(
    valueToNormalize: unknown,
  ): Record<string, string>[] | undefined {
    const parsedValue =
      typeof valueToNormalize === "string"
        ? safeParseJson(valueToNormalize.trim())
        : valueToNormalize;

    if (!Array.isArray(parsedValue)) {
      return undefined;
    }

    const normalizedEntries = parsedValue
      .map((entryValue) => normalizeStringRecord(entryValue))
      .filter(
        (entryValue): entryValue is Record<string, string> =>
          !!entryValue && Object.keys(entryValue).length > 0,
      );

    return normalizedEntries.length > 0 ? normalizedEntries : undefined;
  }

  function stripNullValues(input: unknown): unknown {
    if (input === null || input === undefined) {
      return undefined;
    }

    if (Array.isArray(input)) {
      return input
        .map((item) => stripNullValues(item))
        .filter((item) => item !== undefined);
    }

    if (typeof input !== "object") {
      return input;
    }

    const cleanedEntries = Object.entries(input as Record<string, unknown>)
      .map(([key, entryValue]) => [key, stripNullValues(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined);

    return Object.fromEntries(cleanedEntries);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = stripNullValues(value) as Record<string, unknown>;
  const seoRecord =
    record.seo && typeof record.seo === "object" && !Array.isArray(record.seo)
      ? (record.seo as Record<string, unknown>)
      : null;
  const contactInfoRecord =
    record.contactInfo &&
    typeof record.contactInfo === "object" &&
    !Array.isArray(record.contactInfo)
      ? (record.contactInfo as Record<string, unknown>)
      : null;

  const normalizedSeoRecord = seoRecord
    ? {
        ...seoRecord,
        openGraph: normalizeStringRecord(seoRecord.openGraph),
        twitterCard: normalizeStringRecord(seoRecord.twitterCard),
        schema: normalizeSeoSchemaArray(seoRecord.schema),
        verification: normalizeStringRecord(seoRecord.verification),
      }
    : undefined;
  const normalizedContactInfoRecord = contactInfoRecord
    ? (() => {
        const normalizedEmail = normalizeOptionalEmail(contactInfoRecord.email);
        const contactInfoWithoutEmail = Object.fromEntries(
          Object.entries(contactInfoRecord).filter(([key]) => key !== "email"),
        );
        return {
          ...contactInfoWithoutEmail,
          ...(normalizedEmail ? { email: normalizedEmail } : {}),
        };
      })()
    : undefined;

  return {
    ...record,
    ...(normalizedSeoRecord ? { seo: normalizedSeoRecord } : {}),
    ...(normalizedContactInfoRecord
      ? { contactInfo: normalizedContactInfoRecord }
      : {}),
    userId:
      typeof record.userId === "string" && record.userId.trim().length > 0
        ? record.userId
        : userId,
  };
}

export function normalizeToolWebsiteAnalysisForPersistence(
  value: unknown,
  userId: string,
): WebsiteAnalysisPayload {
  return WEBSITE_ANALYSIS.parse(
    normalizeWebsiteAnalysisCandidate(value, userId),
  );
}

function parseWebsiteAnalysisCandidate(
  value: unknown,
  userId: string,
): WebsiteAnalysisPayload | null {
  try {
    return normalizeToolWebsiteAnalysisForPersistence(value, userId);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return null;
    }

    return null;
  }
}

function pushUniqueCandidate(candidates: string[], value: string): void {
  const trimmedValue = value.trim();
  if (!trimmedValue || candidates.includes(trimmedValue)) {
    return;
  }

  candidates.push(trimmedValue);
}

function extractCodeBlockCandidates(text: string): string[] {
  const candidates: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;

  for (const match of text.matchAll(pattern)) {
    if (match[1]) {
      pushUniqueCandidate(candidates, match[1]);
    }
  }

  return candidates;
}

function extractBalancedJsonObjects(text: string): string[] {
  const candidates: string[] = [];
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        pushUniqueCandidate(candidates, text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return candidates;
}

export function getOnboardingCreateDefaults(flow?: BusinessOnboardingFlow | null): {
  websiteStatus: string;
  isActive: boolean;
  isPrimary?: boolean;
} {
  if (flow === "website_secondary") {
    return {
      websiteStatus: "pending",
      isActive: true,
      isPrimary: false,
    };
  }

  if (flow === "trial_primary") {
    return {
      websiteStatus: "trial",
      isActive: true,
      isPrimary: true,
    };
  }

  return {
    websiteStatus: "active",
    isActive: true,
  };
}

function formatSuccessResult(result: PersistAnalyzedBusinessResult): string {
  return `${ONBOARDING_LLM_SUCCESS_PREFIX}${JSON.stringify(result)}`;
}

function buildValidationFailure(
  stage: string,
  message: string,
  error: z.ZodError | unknown,
): OnboardingPersistenceError {
  const details =
    error instanceof z.ZodError
      ? error.flatten()
      : {
          error: error instanceof Error ? error.message : String(error),
        };

  return new OnboardingPersistenceError({
    code: "analysis_validation_failed",
    stage,
    message,
    details,
    cause: error,
  });
}

function buildScrapeFailure(
  websiteUrl: string,
  error: unknown,
): OnboardingFailureLike {
  if (error instanceof OnboardingScrapeError) {
    return {
      code: error.code,
      stage: error.stage,
      message: error.message,
      details: {
        websiteUrl,
        ...(error.details !== undefined ? { failureDetails: error.details } : {}),
      },
    };
  }

  return {
    code: "site_inaccessible",
    stage: "get_website_info",
    message: `Unable to access site content for ${websiteUrl}.`,
    details: {
      websiteUrl,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function formatFailureResult(error: OnboardingFailureLike): string {
  return `${ONBOARDING_LLM_FAILURE_PREFIX}${JSON.stringify({
    code: error.code,
    stage: error.stage,
    message: error.message,
    details: error.details ?? null,
  })}`;
}

function logToolFailure(
  label: string,
  error: OnboardingFailureLike,
): void {
  console.error(
    label,
    inspect(
      {
        code: error.code,
        stage: error.stage,
        message: error.message,
        details: error.details ?? null,
      },
      { depth: null, colors: true },
    ),
  );
}

export function extractPersistedBusinessResultFromText(
  value: unknown,
): PersistAnalyzedBusinessResult | null {
  const content = getTextContent(value);

  const prefixIndex = content.indexOf(ONBOARDING_LLM_SUCCESS_PREFIX);
  if (prefixIndex < 0) {
    return null;
  }

  const payload = content
    .slice(prefixIndex + ONBOARDING_LLM_SUCCESS_PREFIX.length)
    .trim();
  if (!payload) {
    return null;
  }

  try {
    const parsed = persistedBusinessResultSchema.parse(JSON.parse(payload));
    return {
      businessId: parsed.businessId,
      websiteAnalysisId: parsed.websiteAnalysisId ?? null,
      normalizedUrl: parsed.normalizedUrl,
    };
  } catch {
    return null;
  }
}

export function extractOnboardingFailureResultFromText(
  value: unknown,
): z.infer<typeof onboardingFailureResultSchema> | null {
  const content = getTextContent(value);
  const prefixIndex = content.indexOf(ONBOARDING_LLM_FAILURE_PREFIX);

  if (prefixIndex < 0) {
    return null;
  }

  const payload = content
    .slice(prefixIndex + ONBOARDING_LLM_FAILURE_PREFIX.length)
    .trim();
  if (!payload) {
    return null;
  }

  try {
    return onboardingFailureResultSchema.parse(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function extractWebsiteAnalysisFromToolCalls(
  toolCalls: unknown,
  userId: string,
): WebsiteAnalysisPayload | null {
  if (!Array.isArray(toolCalls)) {
    return null;
  }

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index] as ToolCallLike | undefined;
    if (!toolCall || toolCall.name !== "save-business-data-to-database") {
      continue;
    }

    const parsedAnalysis = parseWebsiteAnalysisCandidate(
      toolCall.args,
      userId,
    );
    if (parsedAnalysis) {
      return parsedAnalysis;
    }
  }

  return null;
}

export function extractWebsiteAnalysisFromText(
  value: unknown,
  userId: string,
): WebsiteAnalysisPayload | null {
  const content = getTextContent(value);
  if (!content.trim()) {
    return null;
  }

  const candidates: string[] = [];
  pushUniqueCandidate(candidates, content);

  for (const candidate of extractCodeBlockCandidates(content)) {
    pushUniqueCandidate(candidates, candidate);
  }

  for (const candidate of extractBalancedJsonObjects(content)) {
    pushUniqueCandidate(candidates, candidate);
  }

  for (const candidate of candidates.sort((left, right) => right.length - left.length)) {
    try {
      const parsedJson = JSON.parse(candidate);
      const parsedAnalysis = parseWebsiteAnalysisCandidate(parsedJson, userId);
      if (parsedAnalysis) {
        return parsedAnalysis;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export const getWebsiteDataToolSchema = z.object({
  chunk: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "Specify the chunk number (2, 3, etc.) to get subsequent chunks. Use null for the initial request or when no explicit chunk number is needed.",
    ),
});

export function createGetWebsiteDataTool(
  context: Pick<OnboardingToolContext, "websiteUrl">,
): StructuredToolInterface {
  return createGetWebsiteDataToolWithCache(context, new Map());
}

function mergeDeterministicSeoSignals(
  structuredJson: Record<string, unknown>,
  scrapeSnapshot: OnboardingScrapeSnapshot | null,
): Record<string, unknown> {
  if (!scrapeSnapshot) {
    return structuredJson;
  }

  const existingBrandIdentity =
    structuredJson.brandIdentity &&
    typeof structuredJson.brandIdentity === "object" &&
    !Array.isArray(structuredJson.brandIdentity)
      ? (structuredJson.brandIdentity as Record<string, unknown>)
      : {};
  const existingSeo =
    structuredJson.seo &&
    typeof structuredJson.seo === "object" &&
    !Array.isArray(structuredJson.seo)
      ? (structuredJson.seo as Record<string, unknown>)
      : {};
  const seoSignals = scrapeSnapshot.seoSignals;
  const mergedSeo: Record<string, unknown> = {
    ...existingSeo,
    ...(seoSignals.title ? { title: seoSignals.title } : {}),
    ...(seoSignals.metaDescription
      ? { metaDescription: seoSignals.metaDescription }
      : {}),
    ...(seoSignals.canonicalUrl ? { canonicalUrl: seoSignals.canonicalUrl } : {}),
    ...(seoSignals.openGraph ? { openGraph: seoSignals.openGraph } : {}),
    ...(seoSignals.twitterCard ? { twitterCard: seoSignals.twitterCard } : {}),
    ...(seoSignals.schema ? { schema: seoSignals.schema } : {}),
    ...(seoSignals.verification ? { verification: seoSignals.verification } : {}),
  };

  return {
    ...structuredJson,
    brandIdentity: {
      ...existingBrandIdentity,
      ...(seoSignals.favicon ? { favicon: seoSignals.favicon } : {}),
    },
    seo: mergedSeo,
    ...(seoSignals.navigation &&
    (!Array.isArray(structuredJson.navigation) ||
      structuredJson.navigation.length === 0)
      ? { navigation: seoSignals.navigation }
      : {}),
  };
}

export function createGetWebsiteDataToolWithCache(
  context: Pick<OnboardingToolContext, "websiteUrl">,
  scrapeCache: OnboardingScrapeCache,
): StructuredToolInterface {
  return tool(
    async (params) => {
      const { chunk } = params as GetWebsiteDataParams;
      const normalizedUrl = normalizeWebsiteUrl(context.websiteUrl);

      try {
        const parsedUrl = new URL(normalizedUrl);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("Unsupported protocol");
        }
      } catch {
        const failure = buildScrapeFailure(normalizedUrl, new Error("Invalid website URL"));
        logToolFailure("[OnboardingScrape] Invalid website URL:", failure);
        return formatFailureResult(failure);
      }

      let snapshot = scrapeCache.get(normalizedUrl) ?? null;
      if (!snapshot) {
        try {
          snapshot = await scrapeWebsiteForOnboarding(normalizedUrl);
          scrapeCache.set(normalizedUrl, snapshot);
        } catch (error) {
          const failure = buildScrapeFailure(normalizedUrl, error);
          logToolFailure("[OnboardingScrape] Deterministic scrape failed:", failure);
          return formatFailureResult(failure);
        }
      }

      const { payload, serialized } = buildOnboardingWebsiteInfoPayload(
        snapshot,
        chunk,
      );

      console.log(
        "[OnboardingScrape] Prepared markdown-first website payload:",
        inspect(
          {
            url: normalizedUrl,
            finalUrl: snapshot.finalUrl,
            markdownMode: snapshot.markdownMode,
            renderFallbackReason: snapshot.renderFallbackReason,
            structuredFallbackUsed: snapshot.structuredFallbackUsed,
            puppeteerFallbackUsed: snapshot.puppeteerFallbackUsed,
            markdownLength: snapshot.markdown.length,
            currentChunk: payload.currentChunk,
            totalChunks: payload.totalChunks,
            payloadSize: payload.diagnostics.payloadSize,
          },
          { depth: null, colors: true },
        ),
      );

      return serialized;
    },
    {
      name: "get-website-info",
      description:
        "Fetches compact onboarding website data for the fixed canonical website URL already provided in context. The response contains content.markdown for business understanding, seoSignals for exact SEO/meta fields such as title, canonical, Open Graph, Twitter, schema, verification, and diagnostics about the deterministic fallback path that was used. For large sites, content.markdown is split into chunks. If chunked=true, you MUST call this tool again with chunk=N+1 until currentChunk equals totalChunks, then combine all markdown chunks into one final analysis. Never try alternate URLs, domains, sitemap URLs, robots.txt, or proxy URLs.",
      schema: getWebsiteDataToolSchema,
    },
  );
}

export function createStoreDataInDbTool(
  context: OnboardingToolContext,
  scrapeCache: OnboardingScrapeCache = new Map(),
): StructuredToolInterface {
  return tool(
    async (structuredJson: unknown) => {
      try {
        let parsed: z.infer<typeof saveBusinessDataToolSchema>;
        try {
          parsed = saveBusinessDataToolSchema.parse(structuredJson);
        } catch (error) {
          if (error instanceof z.ZodError) {
            const failure = buildValidationFailure(
              "save_tool_validation",
              "Tool input validation failed for onboarding save payload.",
              error,
            );
            logToolFailure(
              "[OnboardingLLMTool] Raw tool-schema validation failed:",
              failure,
            );
            return formatFailureResult(failure);
          }

          throw error;
        }

        const scrapeSnapshot = (() => {
          const rawScrapedUrl = parsed.scrapedUrl;
          if (
            typeof rawScrapedUrl !== "string" ||
            rawScrapedUrl.trim().length === 0
          ) {
            return null;
          }

          return scrapeCache.get(normalizeWebsiteUrl(rawScrapedUrl)) ?? null;
        })();

        let mergedAnalysis: Record<string, unknown>;
        try {
          mergedAnalysis = mergeDeterministicSeoSignals(
            {
              ...parsed,
              userId: context.userId,
            },
            scrapeSnapshot,
          );
        } catch (error) {
          const failure = buildValidationFailure(
            "save_tool_normalization",
            "Failed to prepare onboarding save payload for persistence.",
            error,
          );
          logToolFailure(
            "[OnboardingLLMTool] Payload normalization failed:",
            failure,
          );
          return formatFailureResult(failure);
        }

        let normalizedAnalysis: WebsiteAnalysisPayload;
        try {
          normalizedAnalysis = normalizeToolWebsiteAnalysisForPersistence(
            mergedAnalysis,
            context.userId,
          );
        } catch (error) {
          if (error instanceof z.ZodError) {
            const failure = buildValidationFailure(
              "website_analysis_validation",
              "Normalized onboarding save payload failed WEBSITE_ANALYSIS validation.",
              error,
            );
            logToolFailure(
              "[OnboardingLLMTool] WEBSITE_ANALYSIS validation failed:",
              failure,
            );
            return formatFailureResult(failure);
          }

          throw error;
        }

        const persisted = await persistAnalyzedBusiness({
          rawWebsiteAnalysis: normalizedAnalysis,
          userId: context.userId,
          preferredBusinessId: context.preferredBusinessId,
          correlationId: context.correlationId,
          onboardingFlow: context.onboardingFlow,
          createDefaults: getOnboardingCreateDefaults(context.onboardingFlow),
        });

        console.log(
          "[OnboardingLLMTool] Persisted analyzed business:",
          inspect(persisted, { depth: null, colors: true }),
        );

        return formatSuccessResult(persisted);
      } catch (error) {
        if (error instanceof OnboardingPersistenceError) {
          logToolFailure("[OnboardingLLMTool] Persistence failed:", error);
          return formatFailureResult(error);
        }

        throw error;
      }
    },
    {
      name: "save-business-data-to-database",
      description:
        "This is the FINAL tool to be used. It takes the complete website analysis JSON (with structure: scrapedUrl, domain, userId, brandIdentity, design, techStack, coreServices, seo, contactInfo, etc.) and saves it to the database. After calling this tool successfully, DO NOT call any other tools or generate responses. The task is complete. Returns a TASK_COMPLETE payload on success.",
      schema: saveBusinessDataToolSchema,
    },
  );
}

export function createOnboardingTools(
  context: OnboardingToolContext,
): StructuredToolInterface[] {
  const scrapeCache: OnboardingScrapeCache = new Map();
  return [
    createGetWebsiteDataToolWithCache(context, scrapeCache),
    createStoreDataInDbTool(context, scrapeCache),
  ];
}
