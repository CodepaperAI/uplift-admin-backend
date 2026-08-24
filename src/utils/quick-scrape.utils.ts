import axios from "axios";
import ContextDev from "context.dev";
import type { Browser } from "puppeteer";
import { getLLMForKeywords } from "../config/llm.config";
import { retrieveContextDevBrand } from "../services/context-dev-brand.service";
import { filterOutGenericServices } from "./generic-services.utils";
import { launchStealthBrowser } from "./browser.utils";

const llm = getLLMForKeywords();

const SCRAPER_API_KEY: string = process.env.SCRAPER_API_KEY?.trim() ?? "";
const SCRAPER_API_URL: string = "https://api.scraperapi.com";

const CONTEXT_DEV_TIMEOUT_MS: number = 45_000;
const CONTEXT_DEV_STOP_AFTER_MS: number = 30_000;
const CONTEXT_DEV_MAX_PAGES: number = 2;
const FAST_SCRAPE_TIMEOUT_MS: number = 30_000;
const RENDER_SCRAPE_TIMEOUT_MS: number = 90_000;
const PUPPETEER_FALLBACK_TIMEOUT_MS: number = 45_000;
const PUPPETEER_NETWORK_IDLE_TIMEOUT_MS: number = 8_000;
export const ONBOARDING_SERVICE_MAX_LENGTH = 200;
export const ONBOARDING_SERVICE_MAX_COUNT = 25;

export type QuickScrapeBrandContext = {
  schemaVersion: 2;
  provider:
    | "context.dev.brand.retrieve"
    | "context.dev.web.extract"
    | "fallback";
  retrievedAt: string;
  provenance: {
    identitySource: "context.dev.brand.retrieve" | "existing-extraction";
    identityRetrievedAt?: string;
    identityDomain?: string;
    semanticSource: "context.dev.web.extract" | "fallback";
  };
  brandVoice: string[];
  keyMessages: string[];
  socialContentAngles: string[];
  primaryColors?: string[];
  secondaryColors?: string[];
  fontFamily?: string;
  logoUrl?: string;
  logoAltText?: string;
  faviconUrl?: string;
  referenceImageUrl?: string;
  slogan?: string;
};

export interface QuickScrapeResult {
  businessName: string;
  businessType: string;
  businessDescription?: string;
  targetAudience?: string;
  brandContext?: QuickScrapeBrandContext;
  detectedServices: string[];
  businessAddress?: string;
  businessCity?: string;
  businessState?: string;
  businessCountry?: string;
  businessPhone?: string;
  serviceArea?: string;
  serviceAreaLocations?: string[];
  businessLocationMode?: "physical" | "service_area" | "online_only" | "unknown";
  extractionSource?: string;
  extractionConfidence?: number;
  success: boolean;
  error?: string;
}

type PuppeteerQuickScrapeResult = {
  text: string;
  html: string;
};

export type QuickScrapeProviderDependencies = {
  contextDev: (url: string) => Promise<QuickScrapeResult | null>;
  scraperApi: (url: string) => Promise<string | null>;
  puppeteer: (url: string) => Promise<PuppeteerQuickScrapeResult | null>;
};

export type QuickScrapeSource =
  | {
      provider: "context.dev";
      result: QuickScrapeResult;
    }
  | {
      provider: "scraperapi";
      content: string;
      candidateSource: string;
    }
  | {
      provider: "puppeteer";
      content: string;
      candidateSource: string;
    };

const CONTEXT_DEV_QUICK_SCRAPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    businessName: {
      type: "string",
      description: "The exact public-facing business or organization name.",
    },
    businessType: {
      type: "string",
      description: "A concise description of the business category.",
    },
    businessDescription: {
      type: "string",
      description:
        "A concise factual description of what the business does and who it helps.",
    },
    targetAudience: {
      type: "string",
      description:
        "The primary customer audience explicitly supported by the website.",
    },
    brandVoice: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description: "Short factual descriptors for the site's written voice.",
    },
    keyMessages: {
      type: "array",
      items: { type: "string" },
      maxItems: 5,
      description: "Important customer-facing claims supported by the site.",
    },
    socialContentAngles: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
      description:
        "Useful social post themes grounded in the site's services and claims.",
    },
    primaryColors: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
      description:
        "Primary brand colors explicitly visible in the site design, preferably as CSS hex values.",
    },
    secondaryColors: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
      description:
        "Secondary or accent colors explicitly visible in the site design, preferably as CSS hex values.",
    },
    fontFamily: {
      type: "string",
      description:
        "The primary visible brand font family when supported by the site source, otherwise empty.",
    },
    logoUrl: {
      type: "string",
      description:
        "An absolute URL for the primary business logo when present, otherwise empty.",
    },
    logoAltText: {
      type: "string",
      description: "The logo alt text when present, otherwise empty.",
    },
    faviconUrl: {
      type: "string",
      description: "An absolute favicon URL when present, otherwise empty.",
    },
    referenceImageUrl: {
      type: "string",
      description:
        "An absolute URL for one representative business or hero image when present, otherwise empty.",
    },
    services: {
      type: "array",
      items: { type: "string", maxLength: ONBOARDING_SERVICE_MAX_LENGTH },
      maxItems: 10,
      description: "Specific customer-facing services or products offered.",
    },
    businessAddress: { type: "string" },
    businessCity: { type: "string" },
    businessState: { type: "string" },
    businessCountry: { type: "string" },
    businessPhone: { type: "string" },
    serviceArea: {
      type: "string",
      description: "One of local, regional, national, international, online, or empty.",
    },
    serviceAreaLocations: {
      type: "array",
      items: { type: "string" },
      maxItems: 12,
    },
    businessLocationMode: {
      type: "string",
      enum: ["physical", "service_area", "online_only", "unknown"],
    },
    extractionConfidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
  required: [
    "businessName",
    "businessType",
    "businessDescription",
    "targetAudience",
    "brandVoice",
    "keyMessages",
    "socialContentAngles",
    "primaryColors",
    "secondaryColors",
    "fontFamily",
    "logoUrl",
    "logoAltText",
    "faviconUrl",
    "referenceImageUrl",
    "services",
    "businessAddress",
    "businessCity",
    "businessState",
    "businessCountry",
    "businessPhone",
    "serviceArea",
    "serviceAreaLocations",
    "businessLocationMode",
    "extractionConfidence",
  ],
} as const;

type FetchQuickScrapeMarkdownOptions = {
  render: boolean;
  timeoutMs: number;
};

type ContactExtractionCandidates = {
  phones: string[];
  addresses: string[];
  jsonLdBusinessName?: string;
  jsonLdBusinessType?: string;
  jsonLdPhone?: string;
  jsonLdAddress?: string;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeServiceLabel(value: unknown): string {
  if (typeof value !== "string") return "";

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= ONBOARDING_SERVICE_MAX_LENGTH) return normalized;

  const bounded = normalized.slice(0, ONBOARDING_SERVICE_MAX_LENGTH);
  const lastWordBoundary = bounded.lastIndexOf(" ");
  return (lastWordBoundary >= 120 ? bounded.slice(0, lastWordBoundary) : bounded)
    .replace(/[,:;–—-]+$/u, "")
    .trim();
}

export function normalizeOnboardingServiceList(
  value: unknown,
  maxItems = ONBOARDING_SERVICE_MAX_COUNT,
): string[] {
  if (!Array.isArray(value)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  const boundedMaxItems = Math.max(
    0,
    Math.min(ONBOARDING_SERVICE_MAX_COUNT, Math.floor(maxItems)),
  );
  if (boundedMaxItems === 0) return [];

  for (const candidate of value) {
    const service = normalizeServiceLabel(candidate);
    const dedupeKey = service.toLocaleLowerCase("en-US");
    if (!service || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(service);
    if (normalized.length >= boundedMaxItems) break;
  }

  return normalized;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeBrandColors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((candidate) => {
          if (typeof candidate === "string") return candidate.trim();
          return normalizeString(recordValue(candidate).hex);
        })
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

function normalizedBrandLogoUrl(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  const logos = value.map(recordValue);
  const selected =
    logos.find((logo) => normalizeString(logo.type) === "logo") ?? logos[0];
  return normalizeString(selected?.url);
}

function normalizedBrandBackdropUrl(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return normalizeString(recordValue(value[0]).url);
}

type QuickScrapeBrandEnvelopeOptions = {
  provider: QuickScrapeBrandContext["provider"];
  retrievedAt?: string;
  semanticSource: QuickScrapeBrandContext["provenance"]["semanticSource"];
};

function semanticBrandContext(
  data: Record<string, unknown>,
  options: QuickScrapeBrandEnvelopeOptions,
): QuickScrapeBrandContext {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const slogan = normalizeString(data.slogan);
  return {
    schemaVersion: 2,
    provider: options.provider,
    retrievedAt,
    provenance: {
      identitySource: "existing-extraction",
      semanticSource: options.semanticSource,
    },
    brandVoice: normalizeStringArray(data.brandVoice).slice(0, 4),
    keyMessages: normalizeStringArray(data.keyMessages).slice(0, 5),
    socialContentAngles: normalizeStringArray(data.socialContentAngles).slice(
      0,
      6,
    ),
    primaryColors: normalizeBrandColors(data.primaryColors).slice(0, 4),
    secondaryColors: normalizeBrandColors(data.secondaryColors).slice(0, 6),
    fontFamily: normalizeString(data.fontFamily),
    logoUrl: normalizeString(data.logoUrl),
    logoAltText: normalizeString(data.logoAltText),
    faviconUrl: normalizeString(data.faviconUrl),
    referenceImageUrl: normalizeString(data.referenceImageUrl),
    ...(slogan ? { slogan } : {}),
  };
}

/**
 * Merge only normalized brand identity fields into the semantic website facts.
 * The provider response remains backend-private; consumers keep the existing
 * flat brandContext keys used by blog and social preview generation.
 */
export function mergeContextDevBrandProfile(
  semantic: QuickScrapeResult,
  profile: unknown,
): QuickScrapeResult {
  const identity = recordValue(profile);
  const nestedBrand = recordValue(identity.brand);
  const source = Object.keys(nestedBrand).length > 0 ? nestedBrand : identity;
  const colors = normalizeBrandColors(source.colors);
  const directPrimaryColors = normalizeBrandColors(
    identity.primaryColors ?? source.primaryColors,
  );
  const directSecondaryColors = normalizeBrandColors(
    identity.secondaryColors ?? source.secondaryColors,
  );
  const primaryColors = (directPrimaryColors.length > 0
    ? directPrimaryColors
    : colors.slice(0, 4)
  ).slice(0, 4);
  const secondaryColors = (directSecondaryColors.length > 0
    ? directSecondaryColors
    : colors.slice(4)
  ).slice(0, 6);
  const logoUrl =
    normalizeString(identity.logoUrl ?? source.logoUrl) ||
    normalizedBrandLogoUrl(identity.logos ?? source.logos);
  const referenceImageUrl =
    normalizeString(identity.referenceImageUrl ?? source.referenceImageUrl) ||
    normalizedBrandBackdropUrl(identity.backdrops ?? source.backdrops);
  const identityDomain = normalizeString(identity.domain ?? source.domain);
  const identityRetrievedAt = normalizeString(identity.retrievedAt);
  const slogan = normalizeString(identity.slogan ?? source.slogan);
  const hasIdentity = Boolean(
    primaryColors.length > 0 ||
      secondaryColors.length > 0 ||
      logoUrl ||
      referenceImageUrl ||
      slogan,
  );
  const current =
    semantic.brandContext ??
    semanticBrandContext({}, {
      provider: "context.dev.web.extract",
      semanticSource: "context.dev.web.extract",
    });

  if (!hasIdentity) return semantic;

  return {
    ...semantic,
    brandContext: {
      ...current,
      provider: "context.dev.brand.retrieve",
      retrievedAt: identityRetrievedAt || current.retrievedAt,
      provenance: {
        ...current.provenance,
        identitySource: "context.dev.brand.retrieve",
        ...(identityRetrievedAt ? { identityRetrievedAt } : {}),
        ...(identityDomain ? { identityDomain } : {}),
      },
      ...(primaryColors.length > 0 ? { primaryColors } : {}),
      ...(secondaryColors.length > 0 ? { secondaryColors } : {}),
      ...(normalizeString(identity.fontFamily ?? source.fontFamily)
        ? {
            fontFamily: normalizeString(
              identity.fontFamily ?? source.fontFamily,
            ),
          }
        : {}),
      ...(logoUrl ? { logoUrl } : {}),
      ...(normalizeString(identity.logoAltText ?? source.logoAltText)
        ? {
            logoAltText: normalizeString(
              identity.logoAltText ?? source.logoAltText,
            ),
          }
        : {}),
      ...(normalizeString(identity.faviconUrl ?? source.faviconUrl)
        ? {
            faviconUrl: normalizeString(
              identity.faviconUrl ?? source.faviconUrl,
            ),
          }
        : {}),
      ...(referenceImageUrl ? { referenceImageUrl } : {}),
      ...(slogan ? { slogan } : {}),
    },
  };
}

function normalizePhone(value: unknown): string {
  const phone = normalizeString(value);
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) {
    return "";
  }

  return phone;
}

function normalizeLocationMode(
  value: unknown,
): "physical" | "service_area" | "online_only" | "unknown" {
  if (
    value === "physical" ||
    value === "service_area" ||
    value === "online_only" ||
    value === "unknown"
  ) {
    return value;
  }

  return "unknown";
}

function flattenAddress(address: unknown): string {
  if (typeof address === "string") {
    return address.trim();
  }

  if (!address || typeof address !== "object") {
    return "";
  }

  const record = address as Record<string, unknown>;
  const street = [record.streetAddress, record.addressLocality, record.addressRegion, record.postalCode, record.addressCountry]
    .map(normalizeString)
    .filter(Boolean);

  return street.join(", ");
}

function extractJsonLdCandidates(content: string): ContactExtractionCandidates {
  const candidates: ContactExtractionCandidates = {
    phones: [],
    addresses: [],
  };
  const scriptMatches = content.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const match of scriptMatches) {
    const rawJson = match[1]?.trim();
    if (!rawJson) continue;

    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const type = record["@type"];
        const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
        const looksLikeBusiness = types.some((entry) =>
          /LocalBusiness|Organization|Restaurant|Store|ProfessionalService|LegalService|MedicalBusiness/i.test(entry),
        );
        if (!looksLikeBusiness) continue;

        const name = normalizeString(record.name);
        const telephone = normalizePhone(record.telephone);
        const address = flattenAddress(record.address);
        if (name) candidates.jsonLdBusinessName = name;
        if (types[0]) candidates.jsonLdBusinessType = types[0];
        if (telephone) {
          candidates.jsonLdPhone = telephone;
          candidates.phones.push(telephone);
        }
        if (address) {
          candidates.jsonLdAddress = address;
          candidates.addresses.push(address);
        }
      }
    } catch {
      // Ignore malformed JSON-LD; the LLM still gets the page text.
    }
  }

  return candidates;
}

function extractContactCandidates(content: string): ContactExtractionCandidates {
  const jsonLdCandidates = extractJsonLdCandidates(content);
  const phones = new Set(jsonLdCandidates.phones);
  const addresses = new Set(jsonLdCandidates.addresses);
  const phoneMatches = content.matchAll(
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g,
  );

  for (const match of phoneMatches) {
    const phone = normalizePhone(match[0]);
    if (phone) phones.add(phone);
  }

  const addressMatches = content.matchAll(
    /\b\d{1,6}\s+[A-Za-z0-9.'’#-]+(?:\s+[A-Za-z0-9.'’#-]+){1,8}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Court|Ct\.?|Way|Highway|Hwy\.?|Suite|Unit)\b[^\n|]{0,120}/gi,
  );
  for (const match of addressMatches) {
    const address = match[0].replace(/\s+/g, " ").trim();
    if (address.length >= 10) addresses.add(address);
  }

  return {
    ...jsonLdCandidates,
    phones: Array.from(phones).slice(0, 5),
    addresses: Array.from(addresses).slice(0, 5),
  };
}

export function normalizeContextDevQuickScrapeResult(
  data: Record<string, unknown>,
  options: { retrievedAt?: string } = {},
): QuickScrapeResult | null {
  const businessName = normalizeString(data.businessName);
  const businessType = normalizeString(data.businessType);
  const detectedServices = filterOutGenericServices(
    normalizeOnboardingServiceList(data.services, 10),
  ).slice(0, 10);

  // Require a coherent semantic business result, while allowing the user to
  // add services manually when Context.dev found the business but no offerings.
  // Empty/incoherent semantic responses still fall through to existing providers.
  if (!businessName && !businessType) {
    return null;
  }

  return {
    businessName,
    businessType,
    businessDescription: normalizeString(data.businessDescription),
    targetAudience: normalizeString(data.targetAudience),
    brandContext: semanticBrandContext(data, {
      provider: "context.dev.web.extract",
      retrievedAt: options.retrievedAt,
      semanticSource: "context.dev.web.extract",
    }),
    detectedServices,
    businessAddress: normalizeString(data.businessAddress),
    businessCity: normalizeString(data.businessCity),
    businessState: normalizeString(data.businessState),
    businessCountry: normalizeString(data.businessCountry),
    businessPhone: normalizePhone(data.businessPhone),
    serviceArea: normalizeString(data.serviceArea),
    serviceAreaLocations: normalizeStringArray(data.serviceAreaLocations),
    businessLocationMode: normalizeLocationMode(data.businessLocationMode),
    extractionSource: "context.dev",
    extractionConfidence:
      typeof data.extractionConfidence === "number"
        ? Math.max(0, Math.min(1, data.extractionConfidence))
        : 0,
    success: true,
  };
}

async function scrapeWithContextDev(
  url: string,
): Promise<QuickScrapeResult | null> {
  const apiKey = process.env.CONTEXT_DEV_API_KEY?.trim();
  if (!apiKey) {
    console.warn(
      "[Quick Scrape] CONTEXT_DEV_API_KEY is not configured; using fallback providers",
    );
    return null;
  }

  try {
    console.log(`[Quick Scrape] Extracting via Context.dev: ${url}`);
    const client = new ContextDev({
      apiKey,
      timeout: CONTEXT_DEV_TIMEOUT_MS,
      maxRetries: 0,
      logLevel: "error",
    });
    const [response, brandProfile] = await Promise.all([
      client.web.extract({
        url,
        schema: CONTEXT_DEV_QUICK_SCRAPE_SCHEMA,
        factCheck: true,
        maxDepth: 1,
        maxPages: CONTEXT_DEV_MAX_PAGES,
        stopAfterMs: CONTEXT_DEV_STOP_AFTER_MS,
        tags: ["quick-onboarding"],
        instructions:
          "Extract only facts supported by the business website. Prioritize the homepage, services or products, about, and contact information. Return specific customer-facing offerings, a concise audience, the site's actual voice, supported key messages, grounded social content angles, and visible brand identity (logo, colors, font, favicon, and one representative image) when directly supported by the page source. Return absolute asset URLs and CSS hex colors when available. Do not infer an address, phone number, service area, location mode, audience, business claim, or visual identity that the website does not support; use an empty value, empty array, or unknown instead.",
      }),
      retrieveContextDevBrand(url).catch((error: unknown) => {
        console.warn(
          "[Quick Scrape] Context.dev brand identity failed; continuing with semantic extraction",
          {
            message: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }),
    ]);

    const normalized = normalizeContextDevQuickScrapeResult(response.data);
    console.log(
      `[Quick Scrape] Context.dev status=${response.status} pages=${response.urls_analyzed.length} credits=${response.key_metadata?.credits_consumed ?? "unknown"} remaining=${response.key_metadata?.credits_remaining ?? "unknown"}`,
    );

    if (response.status !== "ok" || !normalized) {
      console.warn(
        "[Quick Scrape] Context.dev returned a thin or unusable extraction; using ScraperAPI fallback",
      );
      return null;
    }

    return mergeContextDevBrandProfile(normalized, brandProfile);
  } catch (error: unknown) {
    const contextError = error as {
      message?: string;
      name?: string;
      status?: number;
    };
    console.warn("[Quick Scrape] Context.dev extraction failed; using fallback", {
      name: contextError?.name,
      status: contextError?.status,
      message: contextError?.message,
    });
    return null;
  }
}

async function fetchQuickScrapeMarkdown(
  url: string,
  options: FetchQuickScrapeMarkdownOptions,
): Promise<string | null> {
  try {
    if (!SCRAPER_API_KEY) {
      console.error("[Quick Scrape] SCRAPER_API_KEY is not configured");
      return null;
    }

    const params: URLSearchParams = new URLSearchParams();
    params.set("api_key", SCRAPER_API_KEY);
    params.set("url", url);
    params.set("output_format", "markdown");
    if (options.render) {
      params.set("render", "true");
      params.set("device_type", "desktop");
    }

    const scraperUrl: string = `${SCRAPER_API_URL}/?${params.toString()}`;
    const modeLabel: string = options.render ? "markdown+render" : "markdown";

    console.log(`[Quick Scrape] Fetching via ScraperAPI (${modeLabel}): ${url}`);

    const response = await axios.get<string>(scraperUrl, {
      timeout: options.timeoutMs,
    });

    const markdown: string =
      typeof response.data === "string"
        ? response.data
        : String(response.data);

    if (markdown && markdown.length > 50) {
      console.log(
        `[Quick Scrape] ScraperAPI returned ${markdown.length} chars of markdown`,
      );
      return markdown;
    }

    console.error(
      "[Quick Scrape] ScraperAPI returned empty or too-short response",
    );
    return null;
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const responseBody =
        typeof error.response?.data === "string"
          ? error.response.data.slice(0, 240)
          : undefined;
      console.error("[Quick Scrape] ScraperAPI failed:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        code: error.code,
        message: error.message,
        responseBody,
      });
    } else {
      console.error("[Quick Scrape] ScraperAPI failed:", error);
    }
    return null;
  }
}

async function scrapeWithScraperAPI(url: string): Promise<string | null> {
  const fastResult: string | null = await fetchQuickScrapeMarkdown(url, {
    render: false,
    timeoutMs: FAST_SCRAPE_TIMEOUT_MS,
  });

  if (fastResult) {
    return fastResult;
  }

  console.log("[Quick Scrape] Retrying with render=true");

  return fetchQuickScrapeMarkdown(url, {
    render: true,
    timeoutMs: RENDER_SCRAPE_TIMEOUT_MS,
  });
}

/**
 * Last-resort fallback: render the page locally with a stealth Puppeteer browser.
 * Unlike ScraperAPI, this executes the site's JavaScript on our own infra, so it
 * recovers JS-only sites (e.g. Weebly/Wix) when ScraperAPI's render service is
 * degraded/empty (as in the Jun 2026 JS-rendering incident) or errors entirely.
 * Returns rendered innerText (for the LLM prompt) + full HTML (for deterministic
 * JSON-LD/contact extraction), or null if it cannot get usable content.
 */
async function scrapeWithPuppeteer(
  url: string,
): Promise<PuppeteerQuickScrapeResult | null> {
  let browser: Browser | null = null;
  try {
    console.log(`[Quick Scrape] Falling back to local Puppeteer render: ${url}`);
    browser = await launchStealthBrowser();
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(PUPPETEER_FALLBACK_TIMEOUT_MS);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (
        resourceType === "image" ||
        resourceType === "media" ||
        resourceType === "font"
      ) {
        request.abort();
        return;
      }

      request.continue();
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PUPPETEER_FALLBACK_TIMEOUT_MS,
    });
    await page
      .waitForNetworkIdle({
        idleTime: 1_000,
        timeout: PUPPETEER_NETWORK_IDLE_TIMEOUT_MS,
      })
      .catch(() => {
        console.warn(
          "[Quick Scrape] Puppeteer network-idle wait timed out; extracting loaded content",
        );
      });

    const html: string = await page.content();
    const text: string = await page.evaluate(
      () => document.body?.innerText ?? "",
    );

    const usableText: string = text.trim().length > 50 ? text : "";
    if (usableText || (html && html.length > 50)) {
      console.log(
        `[Quick Scrape] Puppeteer fallback rendered ${usableText.length} text / ${html.length} html chars`,
      );
      return { text: usableText || html, html };
    }

    console.error("[Quick Scrape] Puppeteer fallback returned empty content");
    return null;
  } catch (error: unknown) {
    console.error("[Quick Scrape] Puppeteer fallback failed:", error);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore browser close errors
      }
    }
  }
}

const defaultQuickScrapeProviders: QuickScrapeProviderDependencies = {
  contextDev: scrapeWithContextDev,
  scraperApi: scrapeWithScraperAPI,
  puppeteer: scrapeWithPuppeteer,
};

export async function resolveQuickScrapeSource(
  url: string,
  providers: QuickScrapeProviderDependencies = defaultQuickScrapeProviders,
): Promise<QuickScrapeSource | null> {
  const contextResult = await providers.contextDev(url);
  if (contextResult) {
    return {
      provider: "context.dev",
      result: contextResult,
    };
  }

  const scraperApiResult = await providers.scraperApi(url);
  if (scraperApiResult) {
    return {
      provider: "scraperapi",
      content: scraperApiResult,
      candidateSource: scraperApiResult,
    };
  }

  const puppeteerResult = await providers.puppeteer(url);
  if (puppeteerResult) {
    return {
      provider: "puppeteer",
      content: puppeteerResult.text,
      candidateSource: puppeteerResult.html,
    };
  }

  return null;
}

export async function quickScrapeServices(
  websiteUrl: string,
  providers: QuickScrapeProviderDependencies = defaultQuickScrapeProviders,
): Promise<QuickScrapeResult> {
  try {
    let normalizedUrl: string = websiteUrl.trim();
    if (
      !normalizedUrl.startsWith("http://") &&
      !normalizedUrl.startsWith("https://")
    ) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    console.log(`[Quick Scrape] Starting scrape for: ${normalizedUrl}`);
    const startTime: number = Date.now();

    const source = await resolveQuickScrapeSource(normalizedUrl, providers);
    if (source?.provider === "context.dev") {
      const elapsedTime: number = Date.now() - startTime;
      console.log(
        `[Quick Scrape] Completed via Context.dev in ${elapsedTime}ms`,
      );
      return {
        ...source.result,
        detectedServices: filterOutGenericServices(
          normalizeOnboardingServiceList(source.result.detectedServices, 10),
        ).slice(0, 10),
      };
    }

    if (!source) {
      return {
        businessName: "",
        businessType: "",
        detectedServices: [],
        success: false,
        error: "Failed to scrape website",
      };
    }

    const markdown = source.content;
    // What to run deterministic JSON-LD/phone/address extraction on. For the
    // ScraperAPI path this is the markdown; for the Puppeteer fallback it's the
    // rendered HTML (so JSON-LD <script> tags are available).
    const candidateSource = source.candidateSource;
    const contentSample: string = markdown.slice(0, 6500);
    const deterministicCandidates = extractContactCandidates(
      candidateSource ?? markdown,
    );

    const prompt = `Analyze this website content and extract:
1. Business name
2. Business type (e.g., "Plumbing Company", "Restaurant", "Law Firm")
3. A concise factual business description and target audience
4. List of services offered (max 10 services)
5. Brand voice, supported key messages, and grounded social content angles
6. Visible brand colors, font, logo, favicon, and one representative image
7. Business contact/location details if explicitly present

Use these deterministic candidates when they look correct. Do not invent address,
phone, city, state, country, or service area if the content does not support it.

Detected candidates:
${JSON.stringify(deterministicCandidates, null, 2)}

Website URL: ${normalizedUrl}

Content:
${contentSample}

Respond in JSON format:
{
  "businessName": "extracted name",
  "businessType": "extracted type",
  "businessDescription": "concise factual description",
  "targetAudience": "audience supported by the website",
  "brandVoice": ["voice descriptor"],
  "keyMessages": ["supported customer-facing claim"],
  "socialContentAngles": ["grounded social post theme"],
  "primaryColors": ["#112233"],
  "secondaryColors": ["#445566"],
  "fontFamily": "visible font family or empty string",
  "logoUrl": "absolute logo URL or empty string",
  "logoAltText": "logo alt text or empty string",
  "faviconUrl": "absolute favicon URL or empty string",
  "referenceImageUrl": "absolute representative image URL or empty string",
  "services": ["service1", "service2", "service3"],
  "businessAddress": "street address if present",
  "businessCity": "city if present or obvious from address",
  "businessState": "state/province if present",
  "businessCountry": "country if present",
  "businessPhone": "phone number if present",
  "serviceArea": "local | regional | national | international | online",
  "serviceAreaLocations": ["city1", "city2"],
  "businessLocationMode": "physical | service_area | online_only | unknown",
  "extractionSource": "json_ld | footer | contact_page_text | inferred | none",
  "extractionConfidence": 0.0
}

If you cannot determine something, use empty string, empty array, "unknown", or 0.
Only use "online_only" when the content clearly says the business is online, remote,
SaaS, ecommerce-only, or has no local service area.`;

    const response = await llm.invoke(prompt);
    const responseText: string = response.content.toString();

    const jsonMatch: RegExpMatchArray | null = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(
        `[Quick Scrape] LLM did not return JSON. Raw: ${responseText.slice(0, 500)}`,
      );
      throw new Error("Failed to parse LLM response");
    }

    let parsed: {
      businessName?: string;
      businessType?: string;
      businessDescription?: string;
      targetAudience?: string;
      brandVoice?: string[];
      keyMessages?: string[];
      socialContentAngles?: string[];
      primaryColors?: string[];
      secondaryColors?: string[];
      fontFamily?: string;
      logoUrl?: string;
      logoAltText?: string;
      faviconUrl?: string;
      referenceImageUrl?: string;
      services?: string[];
      businessAddress?: string;
      businessCity?: string;
      businessState?: string;
      businessCountry?: string;
      businessPhone?: string;
      serviceArea?: string;
      serviceAreaLocations?: string[];
      businessLocationMode?: string;
      extractionSource?: string;
      extractionConfidence?: number;
    };
    try {
      parsed = JSON.parse(jsonMatch[0]) as {
        businessName?: string;
        businessType?: string;
        services?: string[];
      };
    } catch {
      const sanitized: string = jsonMatch[0]
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
        .replace(/[\x00-\x1F\x7F]/g, " ");
      try {
        parsed = JSON.parse(sanitized) as {
          businessName?: string;
          businessType?: string;
          services?: string[];
        };
      } catch {
        console.error(
          `[Quick Scrape] Failed to parse LLM JSON after sanitization. Raw: ${jsonMatch[0].slice(0, 500)}`,
        );
        throw new Error("Failed to parse LLM response as JSON");
      }
    }

    const elapsedTime: number = Date.now() - startTime;
    console.log(`[Quick Scrape] Completed in ${elapsedTime}ms`);

    return {
      businessName: parsed.businessName || "",
      businessType: parsed.businessType || "",
      businessDescription: normalizeString(parsed.businessDescription),
      targetAudience: normalizeString(parsed.targetAudience),
      brandContext: semanticBrandContext(
        parsed as Record<string, unknown>,
        {
          provider: "fallback",
          semanticSource: "fallback",
        },
      ),
      detectedServices: filterOutGenericServices(
        normalizeOnboardingServiceList(parsed.services, 10),
      ).slice(0, 10),
      businessAddress:
        normalizeString(parsed.businessAddress) ||
        deterministicCandidates.jsonLdAddress ||
        deterministicCandidates.addresses[0] ||
        "",
      businessCity: normalizeString(parsed.businessCity),
      businessState: normalizeString(parsed.businessState),
      businessCountry: normalizeString(parsed.businessCountry),
      businessPhone:
        normalizePhone(parsed.businessPhone) ||
        deterministicCandidates.jsonLdPhone ||
        deterministicCandidates.phones[0] ||
        "",
      serviceArea: normalizeString(parsed.serviceArea),
      serviceAreaLocations: normalizeStringArray(parsed.serviceAreaLocations),
      businessLocationMode: normalizeLocationMode(parsed.businessLocationMode),
      extractionSource: normalizeString(parsed.extractionSource),
      extractionConfidence:
        typeof parsed.extractionConfidence === "number"
          ? Math.max(0, Math.min(1, parsed.extractionConfidence))
          : 0,
      success: true,
    };
  } catch (error: unknown) {
    console.error("[Quick Scrape] Error:", error);
    return {
      businessName: "",
      businessType: "",
      detectedServices: [],
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
