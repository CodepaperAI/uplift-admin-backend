import type { BusinessContextAnalysis } from "../llm/keywords/business-context-analyzer";
import { getLocationCode } from "./location.utils";
import {
  getLocaleInfo,
  languageToDefaultLocale,
  validateLanguageCode,
  validateLocaleCode,
} from "./language.utils";

const COUNTRY_BY_LOCALE_CODE: Record<string, string> = {
  AU: "Australia",
  BR: "Brazil",
  CA: "Canada",
  DE: "Germany",
  ES: "Spain",
  FR: "France",
  GB: "United Kingdom",
  MX: "Mexico",
  PT: "Portugal",
  US: "USA",
};

const NON_ENGLISH_CONTENT_SIGNALS: Record<string, RegExp[]> = {
  de: [
    /[äöüß]/i,
    /\b(für|frauen|männer|haar|haare|haarausfall|haarfüller|haarfiller|haarverdichtung|natürlich|natürliche|inhaltsstoffe|schnell(?:e|er)?|versand|werkteg|werktege|kundensupport|bestpreis|geheimratsecken|tons?ur|schweiß|wasserfest|sichtbar|dünn(?:es|er|em)?|abdecken|kaschieren)\b/i,
  ],
  fr: [/\b(pour|femme|homme|cheveux|livraison|naturel|naturelle|sans|meilleur|clientèle)\b/i],
  es: [/\b(para|mujer|hombre|cabello|envío|natural|sin|mejor|cliente)\b/i],
  pt: [/\b(para|mulher|homem|cabelo|envio|natural|sem|melhor|cliente)\b/i],
};

export type DataForSEOKeywordTarget = {
  locationCode: number;
  locationCountry: string;
  locationCity: string | null;
  languageCode: string;
  locale: string;
  reason: string;
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function extractLocale(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/_/g, "-");
  const valid = validateLocaleCode(normalized);
  return valid === "en-US" && normalized !== "en-US" ? null : valid;
}

function extractLanguage(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/_/g, "-");
  const locale = extractLocale(normalized);
  if (locale) {
    return getLocaleInfo(locale)?.languageCode ?? null;
  }

  const language = validateLanguageCode(normalized.toLowerCase());
  return language === "en" && normalized.toLowerCase() !== "en" ? null : language;
}

function inferContentLanguage(text: string): string | null {
  for (const [languageCode, patterns] of Object.entries(NON_ENGLISH_CONTENT_SIGNALS)) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return languageCode;
    }
  }

  return null;
}

function collectBusinessLanguageText(
  business: any,
  businessContext?: BusinessContextAnalysis | null,
): string {
  const keywords = toStringArray(business?.keywords?.map?.((item: any) => item?.keyword));
  const coreServices = business?.websiteAnalysis?.coreServices;
  const businessInfo = business?.websiteAnalysis?.businessInfo;

  return [
    business?.businessName,
    business?.businessType,
    business?.businessDescription,
    business?.targetAudience,
    businessInfo?.businessSummary,
    businessInfo?.targetAudience,
    businessInfo?.industryPositioning,
    ...(businessInfo?.businessGoals ?? []),
    ...(businessInfo?.valuePropositions ?? []),
    ...(businessInfo?.customerPainPoints ?? []),
    ...(businessInfo?.uniqueSellingPoints ?? []),
    ...(coreServices?.topLevel ?? []),
    ...(coreServices?.subOfferings ?? []),
    ...(coreServices?.industryFocus ?? []),
    ...(businessContext?.services.primary ?? []),
    ...(businessContext?.services.secondary ?? []),
    businessContext?.services.industry,
    businessContext?.market.industry.vertical,
    ...(businessContext?.market.industry.subVertical ?? []),
    businessContext?.market.customerSegment.primary,
    ...(businessContext?.keywordStrategy.mustHaveKeywords ?? []),
    ...(businessContext?.keywordStrategy.focusAreas ?? []),
    ...keywords,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

function getCountryForLocale(localeCode: string): string | null {
  const locale = getLocaleInfo(localeCode);
  if (!locale) {
    return null;
  }

  return COUNTRY_BY_LOCALE_CODE[locale.countryCode] ?? null;
}

function resolvePreferredLocale(
  business: any,
  languageCode: string,
  supportedLocale: string | null,
): string {
  if (supportedLocale && getLocaleInfo(supportedLocale)?.languageCode === languageCode) {
    return supportedLocale;
  }

  const defaultLocale = extractLocale(business?.defaultLocale);
  if (defaultLocale && getLocaleInfo(defaultLocale)?.languageCode === languageCode) {
    return defaultLocale;
  }

  return languageToDefaultLocale(languageCode);
}

export function resolveDataForSEOKeywordTarget(
  business: any,
  businessContext?: BusinessContextAnalysis | null,
): DataForSEOKeywordTarget {
  const supportedValues = toStringArray(business?.supportedLanguages);
  const supportedLocales = supportedValues
    .map(extractLocale)
    .filter((locale): locale is string => Boolean(locale));
  const supportedLanguages = supportedValues
    .map(extractLanguage)
    .filter((language): language is string => Boolean(language));

  const defaultLocale = extractLocale(business?.defaultLocale);
  const defaultLocaleLanguage = defaultLocale
    ? getLocaleInfo(defaultLocale)?.languageCode ?? null
    : null;
  const defaultLanguage = extractLanguage(business?.defaultLanguage);
  const contentLanguage = inferContentLanguage(
    collectBusinessLanguageText(business, businessContext),
  );

  const nonEnglishSupported = supportedLanguages.find((language) => language !== "en");
  const explicitNonEnglish =
    nonEnglishSupported ||
    (defaultLocaleLanguage && defaultLocaleLanguage !== "en" ? defaultLocaleLanguage : null) ||
    (defaultLanguage && defaultLanguage !== "en" ? defaultLanguage : null);

  const languageCode =
    explicitNonEnglish ||
    contentLanguage ||
    defaultLocaleLanguage ||
    defaultLanguage ||
    "en";

  const supportedLocaleForLanguage =
    supportedLocales.find(
      (locale) => getLocaleInfo(locale)?.languageCode === languageCode,
    ) ?? null;
  const locale = resolvePreferredLocale(
    business,
    languageCode,
    supportedLocaleForLanguage,
  );

  const isLocationDependent =
    businessContext?.businessModel?.isLocationDependent === true;
  const localeCountry = getCountryForLocale(locale);
  const businessCountry = cleanString(business?.businessCountry);
  const shouldUseLocaleMarket =
    !isLocationDependent &&
    localeCountry !== null &&
    (languageCode !== "en" || !businessCountry);
  const locationCountry = shouldUseLocaleMarket
    ? localeCountry
    : businessCountry || localeCountry || "USA";
  const locationCity = isLocationDependent ? cleanString(business?.businessCity) || null : null;
  const locationCode = getLocationCode(locationCountry, locationCity ?? undefined);

  const reasonParts = [
    `language=${languageCode}`,
    `locale=${locale}`,
    `country=${locationCountry}`,
  ];
  if (contentLanguage && contentLanguage !== defaultLocaleLanguage) {
    reasonParts.push(`contentSignal=${contentLanguage}`);
  }
  if (!isLocationDependent && businessCountry && locationCountry !== businessCountry) {
    reasonParts.push(`productMarketOverride=${businessCountry}->${locationCountry}`);
  }

  return {
    locationCode,
    locationCountry,
    locationCity,
    languageCode,
    locale,
    reason: reasonParts.join("; "),
  };
}
