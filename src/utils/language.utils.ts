/**
 * Language and Locale utilities for multilanguage blog generation
 * Supports locale-specific variants (e.g., en-CA, fr-CA, en-US, fr-FR)
 */

export interface Language {
  code: string;
  name: string;
  native: string;
}

export interface Locale {
  code: string; // e.g., "en-CA", "fr-CA", "en-US", "fr-FR"
  languageCode: string; // e.g., "en", "fr"
  countryCode: string; // e.g., "CA", "US", "FR"
  name: string; // e.g., "English (Canada)"
  native: string; // e.g., "English (Canada)"
  variant: string; // e.g., "Canadian English", "American English"
  spelling: string; // e.g., "colour" (en-CA) vs "color" (en-US)
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: "en", name: "English", native: "English" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "fr", name: "French", native: "Français" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "ko", name: "Korean", native: "한국어" },
];

export const SUPPORTED_LOCALES: Locale[] = [
  // English variants
  {
    code: "en-CA",
    languageCode: "en",
    countryCode: "CA",
    name: "English (Canada)",
    native: "English (Canada)",
    variant: "Canadian English",
    spelling: "colour, centre, organize, realize",
  },
  {
    code: "en-US",
    languageCode: "en",
    countryCode: "US",
    name: "English (United States)",
    native: "English (United States)",
    variant: "American English",
    spelling: "color, center, organize, realize",
  },
  {
    code: "en-GB",
    languageCode: "en",
    countryCode: "GB",
    name: "English (United Kingdom)",
    native: "English (United Kingdom)",
    variant: "British English",
    spelling: "colour, centre, organise, realise",
  },
  {
    code: "en-AU",
    languageCode: "en",
    countryCode: "AU",
    name: "English (Australia)",
    native: "English (Australia)",
    variant: "Australian English",
    spelling: "colour, centre, organise, realise",
  },

  // French variants
  {
    code: "fr-CA",
    languageCode: "fr",
    countryCode: "CA",
    name: "French (Canada)",
    native: "Français (Canada)",
    variant: "Canadian French",
    spelling: "couleur, centre, organiser (Québec variant)",
  },
  {
    code: "fr-FR",
    languageCode: "fr",
    countryCode: "FR",
    name: "French (France)",
    native: "Français (France)",
    variant: "European French",
    spelling: "couleur, centre, organiser (France variant)",
  },

  // Spanish variants
  {
    code: "es-ES",
    languageCode: "es",
    countryCode: "ES",
    name: "Spanish (Spain)",
    native: "Español (España)",
    variant: "European Spanish",
    spelling: "español, móvil",
  },
  {
    code: "es-MX",
    languageCode: "es",
    countryCode: "MX",
    name: "Spanish (Mexico)",
    native: "Español (México)",
    variant: "Mexican Spanish",
    spelling: "español, celular",
  },
  {
    code: "es-AR",
    languageCode: "es",
    countryCode: "AR",
    name: "Spanish (Argentina)",
    native: "Español (Argentina)",
    variant: "Argentine Spanish",
    spelling: "español, celular (vos)",
  },

  // Other languages (default to standard variants)
  {
    code: "de-DE",
    languageCode: "de",
    countryCode: "DE",
    name: "German (Germany)",
    native: "Deutsch (Deutschland)",
    variant: "Standard German",
    spelling: "deutsch",
  },
  {
    code: "zh-CN",
    languageCode: "zh",
    countryCode: "CN",
    name: "Chinese (Simplified)",
    native: "中文 (简体)",
    variant: "Simplified Chinese",
    spelling: "简体中文",
  },
  {
    code: "ja-JP",
    languageCode: "ja",
    countryCode: "JP",
    name: "Japanese",
    native: "日本語",
    variant: "Standard Japanese",
    spelling: "日本語",
  },
  {
    code: "pt-BR",
    languageCode: "pt",
    countryCode: "BR",
    name: "Portuguese (Brazil)",
    native: "Português (Brasil)",
    variant: "Brazilian Portuguese",
    spelling: "português brasileiro",
  },
  {
    code: "pt-PT",
    languageCode: "pt",
    countryCode: "PT",
    name: "Portuguese (Portugal)",
    native: "Português (Portugal)",
    variant: "European Portuguese",
    spelling: "português europeu",
  },
  {
    code: "it-IT",
    languageCode: "it",
    countryCode: "IT",
    name: "Italian (Italy)",
    native: "Italiano (Italia)",
    variant: "Standard Italian",
    spelling: "italiano",
  },
  {
    code: "ru-RU",
    languageCode: "ru",
    countryCode: "RU",
    name: "Russian (Russia)",
    native: "Русский (Россия)",
    variant: "Standard Russian",
    spelling: "русский",
  },
  {
    code: "ar-SA",
    languageCode: "ar",
    countryCode: "SA",
    name: "Arabic (Saudi Arabia)",
    native: "العربية (السعودية)",
    variant: "Standard Arabic",
    spelling: "العربية",
  },
  {
    code: "hi-IN",
    languageCode: "hi",
    countryCode: "IN",
    name: "Hindi (India)",
    native: "हिन्दी (भारत)",
    variant: "Standard Hindi",
    spelling: "हिन्दी",
  },
  {
    code: "nl-NL",
    languageCode: "nl",
    countryCode: "NL",
    name: "Dutch (Netherlands)",
    native: "Nederlands (Nederland)",
    variant: "Standard Dutch",
    spelling: "nederlands",
  },
  {
    code: "ko-KR",
    languageCode: "ko",
    countryCode: "KR",
    name: "Korean (South Korea)",
    native: "한국어 (대한민국)",
    variant: "Standard Korean",
    spelling: "한국어",
  },
];

/**
 * Parse locale code into language and country
 */
export function parseLocale(locale: string): {
  language: string;
  country: string;
} {
  const parts = locale.split("-");
  return {
    language: parts[0] || "en",
    country: parts[1] || "US",
  };
}

/**
 * Get locale information by code
 */
export function getLocaleInfo(localeCode: string): Locale | null {
  return (
    SUPPORTED_LOCALES.find((locale) => locale.code === localeCode) || null
  );
}

/**
 * Get locale-specific instructions for LLM
 */
export function getLocaleSpecificInstructions(localeCode: string): string {
  const locale = getLocaleInfo(localeCode);
  if (!locale) return "";

  const instructions: string[] = [
    `Use ${locale.variant} spelling and terminology.`,
    `Examples: ${locale.spelling}`,
  ];

  // Add specific regional guidance
  if (locale.code === "en-CA") {
    instructions.push(
      'Use Canadian spelling: "colour", "centre", "organize", "realize". Use Canadian terminology like "washroom" instead of "restroom", "serviette" instead of "napkin".'
    );
  } else if (locale.code === "en-US") {
    instructions.push(
      'Use American spelling: "color", "center", "organize", "realize". Use American terminology like "restroom" instead of "washroom", "napkin" instead of "serviette".'
    );
  } else if (locale.code === "en-GB") {
    instructions.push(
      'Use British spelling: "colour", "centre", "organise", "realise". Use British terminology like "loo" or "toilet" instead of "restroom".'
    );
  } else if (locale.code === "en-AU") {
    instructions.push(
      'Use Australian spelling: "colour", "centre", "organise", "realise". Use Australian terminology and cultural references.'
    );
  } else if (locale.code === "fr-CA") {
    instructions.push(
      'Use Canadian French (Québec variant): "courriel" (not "e-mail"), "fin de semaine" (not "weekend"), "magasinage" (not "shopping"), "dépanneur" (not "épicerie").'
    );
  } else if (locale.code === "fr-FR") {
    instructions.push(
      'Use European French: "e-mail" (not "courriel"), "weekend", "shopping". Use France-specific cultural references.'
    );
  } else if (locale.code === "es-MX") {
    instructions.push(
      'Use Mexican Spanish: "celular" (not "móvil"), Mexican terminology and cultural references.'
    );
  } else if (locale.code === "es-ES") {
    instructions.push(
      'Use European Spanish: "móvil" (not "celular"), Spain-specific terminology and cultural references.'
    );
  } else if (locale.code === "pt-BR") {
    instructions.push(
      'Use Brazilian Portuguese: "celular" (not "telemóvel"), Brazilian terminology and cultural references.'
    );
  } else if (locale.code === "pt-PT") {
    instructions.push(
      'Use European Portuguese: "telemóvel" (not "celular"), Portugal-specific terminology and cultural references.'
    );
  }

  return instructions.join(" ");
}

/**
 * Get language name by code (backward compatibility)
 */
export function getLanguageName(code: string): string {
  const language = SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
  return language?.name || code.toUpperCase();
}

/**
 * Get language native name by code (backward compatibility)
 */
export function getLanguageNativeName(code: string): string {
  const language = SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
  return language?.native || code.toUpperCase();
}

/**
 * Validate language code (backward compatibility)
 */
export function validateLanguageCode(code?: string | null): string {
  if (!code) return "en";
  const normalized = code.toLowerCase().trim();
  const isValid = SUPPORTED_LANGUAGES.some(
    (lang) => lang.code === normalized
  );
  return isValid ? normalized : "en";
}

/**
 * Validate and normalize locale code
 */
export function validateLocaleCode(locale?: string | null): string {
  if (!locale) return "en-US";
  const normalized = locale.trim();
  const isValid = SUPPORTED_LOCALES.some(
    (locale) => locale.code === normalized
  );
  return isValid ? normalized : "en-US";
}

/**
 * Convert language code to default locale
 */
export function languageToDefaultLocale(languageCode: string, country?: string): string {
  const lang = languageCode.toLowerCase().trim();
  
  // If country is provided, try to find matching locale
  if (country) {
    const countryUpper = country.toUpperCase();
    const matchingLocale = SUPPORTED_LOCALES.find(
      (loc) => loc.languageCode === lang && loc.countryCode === countryUpper
    );
    if (matchingLocale) return matchingLocale.code;
  }
  
  // Default mappings
  const defaults: Record<string, string> = {
    en: country?.toUpperCase() === "CA" ? "en-CA" : country?.toUpperCase() === "GB" ? "en-GB" : "en-US",
    fr: country?.toUpperCase() === "CA" ? "fr-CA" : "fr-FR",
    es: country?.toUpperCase() === "MX" ? "es-MX" : country?.toUpperCase() === "AR" ? "es-AR" : "es-ES",
    pt: country?.toUpperCase() === "BR" ? "pt-BR" : "pt-PT",
    de: "de-DE",
    zh: "zh-CN",
    ja: "ja-JP",
    it: "it-IT",
    ru: "ru-RU",
    ar: "ar-SA",
    hi: "hi-IN",
    nl: "nl-NL",
    ko: "ko-KR",
  };
  
  return defaults[lang] || "en-US";
}

/**
 * Detect most used locales based on business context
 */
export function detectLocalesForBusiness(
  businessCountry?: string | null,
  businessCity?: string | null,
  serviceArea?: string | null
): string[] {
  const locales: string[] = [];

  if (businessCountry) {
    const countryLower = businessCountry.toLowerCase();

    // Canada
    if (countryLower.includes("canada") || countryLower.includes("canadá")) {
      locales.push("en-CA", "fr-CA");
    }
    // United States
    else if (
      countryLower.includes("united states") ||
      countryLower.includes("usa") ||
      countryLower.includes("america")
    ) {
      locales.push("en-US");
    }
    // United Kingdom
    else if (
      countryLower.includes("united kingdom") ||
      countryLower.includes("uk") ||
      countryLower.includes("britain")
    ) {
      locales.push("en-GB");
    }
    // Australia
    else if (countryLower.includes("australia")) {
      locales.push("en-AU");
    }
    // Mexico
    else if (countryLower.includes("mexico") || countryLower.includes("méxico")) {
      locales.push("es-MX");
    }
    // Spain
    else if (countryLower.includes("spain") || countryLower.includes("españa")) {
      locales.push("es-ES");
    }
    // Argentina
    else if (countryLower.includes("argentina")) {
      locales.push("es-AR");
    }
    // France
    else if (countryLower.includes("france")) {
      locales.push("fr-FR");
    }
    // Brazil
    else if (countryLower.includes("brazil") || countryLower.includes("brasil")) {
      locales.push("pt-BR");
    }
    // Portugal
    else if (countryLower.includes("portugal")) {
      locales.push("pt-PT");
    }
    // Germany
    else if (countryLower.includes("germany") || countryLower.includes("deutschland")) {
      locales.push("de-DE");
    }
    // China
    else if (countryLower.includes("china")) {
      locales.push("zh-CN");
    }
    // Japan
    else if (countryLower.includes("japan")) {
      locales.push("ja-JP");
    }
    // Italy
    else if (countryLower.includes("italy") || countryLower.includes("italia")) {
      locales.push("it-IT");
    }
    // Russia
    else if (countryLower.includes("russia") || countryLower.includes("россия")) {
      locales.push("ru-RU");
    }
    // India
    else if (countryLower.includes("india")) {
      locales.push("hi-IN", "en-US");
    }
    // Netherlands
    else if (countryLower.includes("netherlands") || countryLower.includes("nederland")) {
      locales.push("nl-NL");
    }
    // South Korea
    else if (countryLower.includes("korea") || countryLower.includes("south korea")) {
      locales.push("ko-KR");
    }
  }

  // City-specific detection
  if (businessCity) {
    const cityLower = businessCity.toLowerCase();
    if (
      cityLower.includes("montreal") ||
      cityLower.includes("montréal") ||
      cityLower.includes("quebec") ||
      cityLower.includes("québec")
    ) {
      if (!locales.includes("fr-CA")) locales.unshift("fr-CA");
      if (!locales.includes("en-CA")) locales.push("en-CA");
    }
  }

  // Service area detection
  if (serviceArea === "international") {
    // Top global locales for international businesses
    if (!locales.includes("en-US")) locales.unshift("en-US");
    locales.push("es-MX", "fr-FR", "de-DE", "zh-CN");
  }

  // Fallback to English (US)
  if (locales.length === 0) {
    locales.push("en-US");
  }

  return locales.slice(0, 5);
}

/**
 * Get all supported locales
 */
export function getAllSupportedLocales(): Locale[] {
  return SUPPORTED_LOCALES;
}

/**
 * Get detected locales for a business
 */
export function getDetectedLocalesForBusiness(business: {
  businessCountry?: string | null;
  businessCity?: string | null;
  serviceArea?: string | null;
  targetAudience?: string | null;
}): {
  detected: string[];
  all: Locale[];
  recommended: Locale[];
} {
  const detected = detectLocalesForBusiness(
    business.businessCountry,
    business.businessCity,
    business.serviceArea
  );

  const recommended = detected
    .map((code) => SUPPORTED_LOCALES.find((loc) => loc.code === code))
    .filter((loc): loc is Locale => loc !== undefined);

  return {
    detected,
    all: SUPPORTED_LOCALES,
    recommended,
  };
}

/**
 * Detect most used languages based on business context (backward compatibility)
 */
export function detectMostUsedLanguages(
  businessCountry?: string | null,
  businessCity?: string | null,
  serviceArea?: string | null,
  targetAudience?: string | null
): string[] {
  const locales = detectLocalesForBusiness(
    businessCountry,
    businessCity,
    serviceArea
  );
  
  // Extract unique language codes
  const languageCodes = new Set<string>();
  locales.forEach(localeCode => {
    const locale = getLocaleInfo(localeCode);
    if (locale) {
      languageCodes.add(locale.languageCode);
    }
  });
  
  return Array.from(languageCodes);
}

/**
 * Get all supported languages (backward compatibility)
 */
export function getAllSupportedLanguages(): Language[] {
  return SUPPORTED_LANGUAGES;
}
