import ContextDev from "context.dev";
import { assertPublicHttpUrl } from "./social-creative/safe-fetch";

const CONTEXT_DEV_BRAND_PROVIDER = "context.dev.brand.retrieve" as const;
const CONTEXT_DEV_BRAND_SCHEMA_VERSION = 1 as const;
const CONTEXT_DEV_BRAND_TIMEOUT_MS = 12_000;
const CONTEXT_DEV_BRAND_PROVIDER_TIMEOUT_MS = 10_000;
const CONTEXT_DEV_BRAND_MAX_RETRIES = 1;
const CONTEXT_DEV_BRAND_MAX_AGE_MS = 86_400_000;

type BrandResponse = ContextDev.BrandRetrieveResponse;
type Brand = NonNullable<BrandResponse["brand"]>;
type BrandLogo = NonNullable<Brand["logos"]>[number];
type BrandBackdrop = NonNullable<Brand["backdrops"]>[number];

export type ContextDevBrandAddress = {
  formatted: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  postalCode: string | null;
  country: string | null;
  countryCode: string | null;
};

export type ContextDevBrandSocial = {
  platform: string;
  url: string;
};

export type ContextDevBrandProfile = {
  schemaVersion: typeof CONTEXT_DEV_BRAND_SCHEMA_VERSION;
  provider: typeof CONTEXT_DEV_BRAND_PROVIDER;
  domain: string;
  retrievedAt: string;
  title: string | null;
  description: string | null;
  slogan: string | null;
  primaryColors: string[];
  secondaryColors: string[];
  logoUrl: string | null;
  logoAltText: string | null;
  faviconUrl: string | null;
  referenceImageUrl: string | null;
  phone: string | null;
  email: string | null;
  address: ContextDevBrandAddress | null;
  socials: ContextDevBrandSocial[];
  usage?: {
    creditsConsumed?: number;
    creditsRemaining?: number;
  };
};

export type ContextDevBrandDependencies = {
  now?: () => Date;
  retrieve?: (
    params: ContextDev.BrandRetrieveParams,
    options: ContextDev.RequestOptions,
  ) => Promise<BrandResponse>;
  validateAssetUrl?: (rawUrl: string) => Promise<URL>;
};

function boundedString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function websiteDomain(websiteUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(
      websiteUrl.includes("://") ? websiteUrl.trim() : `https://${websiteUrl.trim()}`,
    );
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  ) {
    return null;
  }
  return parsed.hostname.replace(/^www\./i, "").replace(/\.+$/, "").toLowerCase();
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(
    normalized,
  )
    ? normalized
    : null;
}

function imageArea(image: BrandLogo | BrandBackdrop): number {
  const width = Number(image.resolution?.width);
  const height = Number(image.resolution?.height);
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? width * height
    : 0;
}

function largestFirst<T extends BrandLogo | BrandBackdrop>(images: T[]): T[] {
  return [...images].sort((left, right) => imageArea(right) - imageArea(left));
}

async function firstValidAssetUrl(
  images: Array<BrandLogo | BrandBackdrop>,
  validateAssetUrl: (rawUrl: string) => Promise<URL>,
): Promise<string | null> {
  for (const image of images) {
    const candidate = boundedString(image.url, 2_048);
    if (!candidate) continue;
    try {
      const validated = await validateAssetUrl(candidate);
      if (validated.protocol === "http:" || validated.protocol === "https:") {
        return validated.toString();
      }
    } catch {
      // Provider assets are optional. Skip unsafe or unresolvable candidates.
    }
  }
  return null;
}

function normalizeSocials(value: Brand["socials"]): ContextDevBrandSocial[] {
  const result: ContextDevBrandSocial[] = [];
  const seen = new Set<string>();
  for (const social of value ?? []) {
    const platform = boundedString(social.type, 40);
    const rawUrl = boundedString(social.url, 2_048);
    if (!platform || !rawUrl) continue;
    try {
      const url = new URL(rawUrl);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password
      ) {
        continue;
      }
      const key = `${platform}:${url.toString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ platform, url: url.toString() });
    } catch {
      // Ignore malformed provider URLs.
    }
  }
  return result.slice(0, 30);
}

function normalizeAddress(value: Brand["address"]): ContextDevBrandAddress | null {
  if (!value) return null;
  const street = boundedString(value.street, 300);
  const city = boundedString(value.city, 120);
  const state = boundedString(value.state_province, 120);
  const stateCode = boundedString(value.state_code, 40);
  const postalCode = boundedString(value.postal_code, 40);
  const country = boundedString(value.country, 120);
  const countryCode = boundedString(value.country_code, 10)?.toUpperCase() ?? null;
  const formatted = [street, city, state || stateCode, postalCode, country]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  if (!formatted) return null;
  return {
    formatted,
    street,
    city,
    state,
    stateCode,
    postalCode,
    country,
    countryCode,
  };
}

function normalizeUsage(
  keyMetadata: BrandResponse["key_metadata"],
): ContextDevBrandProfile["usage"] {
  if (!keyMetadata) return undefined;
  const consumed = Number(keyMetadata.credits_consumed);
  const remaining = Number(keyMetadata.credits_remaining);
  const usage: NonNullable<ContextDevBrandProfile["usage"]> = {};
  if (Number.isFinite(consumed) && consumed >= 0) usage.creditsConsumed = consumed;
  if (Number.isFinite(remaining) && remaining >= 0) usage.creditsRemaining = remaining;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Retrieves a fact-only brand profile from Context.dev. Provider failures and
 * unusable responses deliberately return null so existing scrape fallbacks can
 * continue without making Context.dev a hard dependency.
 */
export async function retrieveContextDevBrand(
  websiteUrl: string,
  dependencies: ContextDevBrandDependencies = {},
): Promise<ContextDevBrandProfile | null> {
  const apiKey = process.env.CONTEXT_DEV_API_KEY?.trim();
  const domain = websiteDomain(websiteUrl);
  if (!apiKey || !domain) return null;

  const retrieve =
    dependencies.retrieve ??
    ((params: ContextDev.BrandRetrieveParams, options: ContextDev.RequestOptions) => {
      const client = new ContextDev({
        apiKey,
        timeout: CONTEXT_DEV_BRAND_TIMEOUT_MS,
        maxRetries: CONTEXT_DEV_BRAND_MAX_RETRIES,
        logLevel: "error",
      });
      return client.brand.retrieve(params, options);
    });

  let response: BrandResponse;
  try {
    response = await retrieve(
      {
        domain,
        type: "by_domain",
        maxAgeMs: CONTEXT_DEV_BRAND_MAX_AGE_MS,
        maxSpeed: false,
        tags: ["onboarding-v2", "brand-context"],
        timeoutMS: CONTEXT_DEV_BRAND_PROVIDER_TIMEOUT_MS,
      },
      {
        timeout: CONTEXT_DEV_BRAND_TIMEOUT_MS,
        maxRetries: CONTEXT_DEV_BRAND_MAX_RETRIES,
      },
    );
  } catch {
    return null;
  }
  if (response.status !== "ok" || !response.brand) return null;

  const brand = response.brand;
  const validateAssetUrl = dependencies.validateAssetUrl ?? assertPublicHttpUrl;
  const logos = largestFirst(brand.logos ?? []);
  const preferredLogos = [
    ...logos.filter((logo) => logo.type === "logo"),
    // Context.dev classifies favicons/app icons separately. Never promote an
    // icon into the full logo field: doing so makes image generation reproduce
    // a tiny favicon while a website wordmark may still be available from the
    // website extraction fallback.
    ...logos.filter(
      (logo) => logo.type !== "logo" && logo.type !== "icon",
    ),
  ];
  const icons = largestFirst(
    (brand.logos ?? []).filter((logo) => logo.type === "icon"),
  );
  const backdrops = largestFirst(brand.backdrops ?? []);
  const [logoUrl, faviconUrl, referenceImageUrl] = await Promise.all([
    firstValidAssetUrl(preferredLogos, validateAssetUrl),
    firstValidAssetUrl(icons, validateAssetUrl),
    firstValidAssetUrl(backdrops, validateAssetUrl),
  ]);
  const colors = [
    ...new Set(
      [
        ...(brand.colors ?? []),
        ...(brand.logos ?? []).flatMap((logo) => logo.colors ?? []),
        ...(brand.backdrops ?? []).flatMap((backdrop) => backdrop.colors ?? []),
      ]
        .map((color) => normalizeHexColor(color.hex))
        .filter((color): color is string => Boolean(color)),
    ),
  ].slice(0, 12);

  const title = boundedString(brand.title, 200);
  const usage = normalizeUsage(response.key_metadata);
  return {
    schemaVersion: CONTEXT_DEV_BRAND_SCHEMA_VERSION,
    provider: CONTEXT_DEV_BRAND_PROVIDER,
    domain,
    retrievedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    title,
    description: boundedString(brand.description, 2_000),
    slogan: boundedString(brand.slogan, 500),
    primaryColors: colors.slice(0, 2),
    secondaryColors: colors.slice(2),
    logoUrl,
    logoAltText: logoUrl ? title : null,
    faviconUrl,
    referenceImageUrl,
    phone: boundedString(brand.phone, 64),
    email: boundedString(brand.email, 320),
    address: normalizeAddress(brand.address),
    socials: normalizeSocials(brand.socials),
    ...(usage ? { usage } : {}),
  };
}
