import { load } from "cheerio";
import { getEquivalentWebsiteUrls } from "./url-normalizer";

export type ManagedBusinessMatchCandidate = {
  businessId: string;
  websiteUrl: string;
};

export type ExternalContentLink = {
  url: string;
  anchorText: string;
};

type WebsiteVariant = {
  businessId: string;
  websiteUrl: string;
  hostname: string;
  pathPrefix: string;
};

function normalizePathPrefix(pathname: string): string {
  const cleaned = pathname.replace(/\/+$/, "");
  return cleaned || "/";
}

function isSupportedProtocol(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

function buildWebsiteVariants(candidate: ManagedBusinessMatchCandidate): WebsiteVariant[] {
  return getEquivalentWebsiteUrls(candidate.websiteUrl)
    .map((variantUrl) => {
      try {
        const parsed = new URL(variantUrl);
        if (!isSupportedProtocol(parsed.protocol)) {
          return null;
        }

        return {
          businessId: candidate.businessId,
          websiteUrl: variantUrl,
          hostname: parsed.hostname.toLowerCase(),
          pathPrefix: normalizePathPrefix(parsed.pathname),
        } satisfies WebsiteVariant;
      } catch {
        return null;
      }
    })
    .filter((variant): variant is WebsiteVariant => variant !== null)
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);
}

export function normalizeManagedLinkUrl(
  rawUrl: string,
  baseUrl?: string | null,
): string | null {
  if (typeof rawUrl !== "string") {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (
    lowered.startsWith("mailto:") ||
    lowered.startsWith("tel:") ||
    lowered.startsWith("javascript:")
  ) {
    return null;
  }

  try {
    const parsed = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (!isSupportedProtocol(parsed.protocol)) {
      return null;
    }

    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    if (parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function sanitizeManagedCandidateLinks<T extends { url: string; score?: number }>(
  candidates: T[],
): T[] {
  const uniqueByNormalizedUrl = new Map<string, T>();

  for (const candidate of candidates) {
    const normalizedUrl = normalizeManagedLinkUrl(candidate.url);
    if (!normalizedUrl) {
      continue;
    }

    const normalizedCandidate = {
      ...candidate,
      url: normalizedUrl,
    } as T;

    const current = uniqueByNormalizedUrl.get(normalizedUrl);
    if (!current || (current.score ?? 0) < (normalizedCandidate.score ?? 0)) {
      uniqueByNormalizedUrl.set(normalizedUrl, normalizedCandidate);
    }
  }

  return Array.from(uniqueByNormalizedUrl.values());
}

export function urlMatchesManagedWebsite(
  rawUrl: string,
  websiteUrl: string,
): boolean {
  const normalizedUrl = normalizeManagedLinkUrl(rawUrl);
  if (!normalizedUrl) {
    return false;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return false;
  }

  const linkPath = normalizePathPrefix(parsedUrl.pathname);

  for (const variant of buildWebsiteVariants({
    businessId: "candidate",
    websiteUrl,
  })) {
    if (parsedUrl.hostname !== variant.hostname) {
      continue;
    }

    if (
      variant.pathPrefix === "/" ||
      linkPath === variant.pathPrefix ||
      linkPath.startsWith(`${variant.pathPrefix}/`)
    ) {
      return true;
    }
  }

  return false;
}

export function extractNormalizedOutboundLinksFromHtml(
  html: string,
  sourceBaseUrl: string,
): string[] {
  const $ = load(html);
  const urls = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const normalized = normalizeManagedLinkUrl(href, sourceBaseUrl);
    if (normalized) {
      urls.add(normalized);
    }
  });

  return Array.from(urls);
}

export function extractExternalLinkUrlsFromHtml(params: {
  html: string;
  sourceBaseUrl: string;
  currentBusinessWebsiteUrl: string;
}): string[] {
  return extractExternalContentLinksFromHtml(params).map((link) => link.url);
}

export function extractExternalContentLinksFromHtml(params: {
  html: string;
  sourceBaseUrl: string;
  currentBusinessWebsiteUrl: string;
}): ExternalContentLink[] {
  const $ = load(params.html);
  const linksByUrl = new Map<string, ExternalContentLink>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const url = normalizeManagedLinkUrl(href, params.sourceBaseUrl);
    if (
      !url ||
      urlMatchesManagedWebsite(url, params.currentBusinessWebsiteUrl)
    ) {
      return;
    }

    const anchorText = $(element).text().replace(/\s+/g, " ").trim();
    const existing = linksByUrl.get(url);
    if (!existing || (!existing.anchorText && anchorText)) {
      linksByUrl.set(url, { url, anchorText });
    }
  });

  return Array.from(linksByUrl.values());
}

export function matchManagedBusinessForUrl(
  rawUrl: string,
  candidates: ManagedBusinessMatchCandidate[],
): { businessId: string; normalizedUrl: string } | null {
  const normalizedUrl = normalizeManagedLinkUrl(rawUrl);
  if (!normalizedUrl) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return null;
  }

  const linkPath = normalizePathPrefix(parsedUrl.pathname);
  const websiteVariants = candidates
    .flatMap((candidate) => buildWebsiteVariants(candidate))
    .sort((left, right) => right.pathPrefix.length - left.pathPrefix.length);

  for (const variant of websiteVariants) {
    if (parsedUrl.hostname !== variant.hostname) {
      continue;
    }

    if (
      variant.pathPrefix === "/" ||
      linkPath === variant.pathPrefix ||
      linkPath.startsWith(`${variant.pathPrefix}/`)
    ) {
      return {
        businessId: variant.businessId,
        normalizedUrl,
      };
    }
  }

  return null;
}
