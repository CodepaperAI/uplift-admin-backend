/**
 * Location utility functions for DataForSEO API
 * Centralizes location code and scope calculations
 */

interface LocationCodeMap {
  [key: string]: number;
}

const COUNTRY_LOCATION_CODES: LocationCodeMap = {
  canada: 2124,
  united_states: 2840,
  usa: 2840,
  us: 2840,
  united_kingdom: 2826,
  uk: 2826,
  australia: 2036,
  germany: 2276,
  france: 2250,
  spain: 2724,
  italy: 2380,
  netherlands: 2528,
  belgium: 2056,
  switzerland: 2756,
  austria: 2040,
  ireland: 2372,
  new_zealand: 2554,
  india: 2356,
  japan: 2392,
  south_korea: 2410,
  china: 2156,
  brazil: 2076,
  mexico: 2484,
  argentina: 2032,
  singapore: 2702,
  hong_kong: 2344,
  united_arab_emirates: 2784,
  uae: 2784,
  saudi_arabia: 2682,
  south_africa: 2710,
  nigeria: 2566,
  egypt: 2818,
  israel: 2376,
  turkey: 2792,
  russia: 2643,
  poland: 2616,
  sweden: 2752,
  norway: 2578,
  denmark: 2208,
  finland: 2246,
  portugal: 2620,
  greece: 2300,
  czech_republic: 2203,
  romania: 2642,
  hungary: 2348,
  thailand: 2764,
  vietnam: 2704,
  malaysia: 2458,
  indonesia: 2360,
  philippines: 2608,
  pakistan: 2586,
  bangladesh: 2050,
  colombia: 2170,
  chile: 2152,
  peru: 2604,
  venezuela: 2862,
};

const CANADIAN_CITY_CODES: LocationCodeMap = {
  toronto: 9000965,
  vancouver: 9000931,
  montreal: 9000921,
  calgary: 9000901,
  edmonton: 9000909,
  ottawa: 9000925,
  winnipeg: 9000973,
  quebec: 9000933,
  hamilton: 9000913,
  kitchener: 9000919,
  london: 9000920,
  victoria: 9000969,
  halifax: 9000911,
  oshawa: 9000924,
  windsor: 9000971,
  saskatoon: 9000947,
  regina: 9000941,
  mississauga: 9000965,
  brampton: 9000965,
  burnaby: 9000931,
  surrey: 9000931,
  markham: 9000965,
  vaughan: 9000965,
  richmond_hill: 9000965,
  oakville: 9000965,
  burlington: 9000913,
};

const US_CITY_CODES: LocationCodeMap = {
  new_york: 1023191,
  los_angeles: 1013962,
  chicago: 1016367,
  houston: 1026339,
  phoenix: 1021142,
  philadelphia: 1014221,
  san_antonio: 1025323,
  san_diego: 1014181,
  dallas: 1026339,
  san_jose: 1014044,
  austin: 1026339,
  jacksonville: 1015112,
  fort_worth: 1026339,
  columbus: 1024277,
  san_francisco: 1014212,
  charlotte: 1022545,
  indianapolis: 1018091,
  seattle: 1027744,
  denver: 1014895,
  washington_dc: 1014670,
  boston: 1018127,
  el_paso: 1026339,
  detroit: 1017483,
  nashville: 1025779,
  portland: 1027500,
  memphis: 1025779,
  oklahoma_city: 1025544,
  las_vegas: 1014220,
  louisville: 1018110,
  baltimore: 1015076,
  milwaukee: 1028195,
  albuquerque: 1015433,
  tucson: 1021142,
  fresno: 1013962,
  sacramento: 1014221,
  kansas_city: 1019986,
  miami: 1015116,
  atlanta: 1015137,
  raleigh: 1022545,
  omaha: 1022268,
  colorado_springs: 1014895,
  virginia_beach: 1027132,
  oakland: 1014212,
  minneapolis: 1019014,
  tulsa: 1025544,
  arlington: 1026339,
  new_orleans: 1020421,
  wichita: 1019445,
};

/**
 * Get DataForSEO location code based on country and city
 * @param country Business country
 * @param city Business city (optional, for more specific targeting)
 * @returns Location code for DataForSEO API
 */
export function getLocationCode(country?: string, city?: string): number {
  const countryLower = country?.toLowerCase()?.replace(/\s+/g, "_") || "";
  const cityLower = city?.toLowerCase()?.replace(/\s+/g, "_") || "";

  if (countryLower.includes("canada") || countryLower === "ca") {
    if (cityLower) {
      const raw = CANADIAN_CITY_CODES[cityLower];
      return Number(raw ?? COUNTRY_LOCATION_CODES.canada);
    }
    return Number(COUNTRY_LOCATION_CODES.canada);
  }

  if (
    countryLower.includes("united_states") ||
    countryLower.includes("usa") ||
    countryLower === "us"
  ) {
    if (cityLower) {
      const raw = US_CITY_CODES[cityLower];
      return Number(raw ?? COUNTRY_LOCATION_CODES.united_states);
    }
    return Number(COUNTRY_LOCATION_CODES.united_states);
  }

  for (const [key, code] of Object.entries(COUNTRY_LOCATION_CODES)) {
    if (countryLower.includes(key)) {
      return code;
    }
  }

  return 2840;
}

/**
 * Get a human-readable location scope string
 * @param city Business city
 * @param state Business state/province
 * @param country Business country
 * @returns Formatted location scope string
 */
export function getLocationScope(
  city?: string,
  state?: string,
  country?: string
): string {
  const parts: string[] = [];

  if (city) parts.push(city);
  if (state) parts.push(state);
  if (country) parts.push(country);

  return parts.join(", ") || "Global";
}

/**
 * Check if location-based keywords are relevant for a business
 * @param country Business country
 * @param serviceArea Service area scope
 * @returns Boolean indicating if location keywords should be prioritized
 */
export function isLocationRelevant(
  country?: string,
  serviceArea?: string
): boolean {
  const serviceAreaLower = serviceArea?.toLowerCase() || "local";

  if (serviceAreaLower === "international" || serviceAreaLower === "global") {
    return false;
  }

  if (serviceAreaLower === "local" || serviceAreaLower === "regional") {
    return true;
  }

  return true;
}

/**
 * Get all locations for keyword generation (business city + service area locations)
 * @param businessCity Business city
 * @param serviceAreaLocations Array of cities/locations in service area
 * @returns Array of unique location names for keyword generation
 */
export function getKeywordLocations(
  businessCity?: string,
  serviceAreaLocations?: string[]
): string[] {
  const locations = new Set<string>();
  
  if (businessCity) {
    locations.add(businessCity.trim());
  }
  
  if (serviceAreaLocations && serviceAreaLocations.length > 0) {
    serviceAreaLocations.forEach((location) => {
      const trimmed = location.trim();
      if (trimmed) {
        locations.add(trimmed);
      }
    });
  }
  
  return Array.from(locations);
}

/**
 * Get country name from location code
 * @param locationCode DataForSEO location code
 * @returns Country name or "Unknown"
 */
export function getCountryFromLocationCode(locationCode: number): string {
  for (const [country, code] of Object.entries(COUNTRY_LOCATION_CODES)) {
    if (code === locationCode) {
      return country.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }
  }
  return "Unknown";
}

/**
 * Get language code based on country
 * @param country Business country
 * @returns ISO 639-1 language code
 */
export function getLanguageCodeFromCountry(country?: string): string {
  const countryLower = country?.toLowerCase() || "";

  const countryLanguageMap: Record<string, string> = {
    canada: "en",
    united_states: "en",
    usa: "en",
    us: "en",
    united_kingdom: "en",
    uk: "en",
    australia: "en",
    germany: "de",
    france: "fr",
    spain: "es",
    italy: "it",
    netherlands: "nl",
    belgium: "nl",
    switzerland: "de",
    austria: "de",
    ireland: "en",
    new_zealand: "en",
    india: "en",
    japan: "ja",
    south_korea: "ko",
    china: "zh",
    brazil: "pt",
    mexico: "es",
    argentina: "es",
    singapore: "en",
    hong_kong: "zh",
    united_arab_emirates: "ar",
    uae: "ar",
    saudi_arabia: "ar",
    south_africa: "en",
    nigeria: "en",
    egypt: "ar",
    israel: "he",
    turkey: "tr",
    russia: "ru",
    poland: "pl",
    sweden: "sv",
    norway: "no",
    denmark: "da",
    finland: "fi",
    portugal: "pt",
    greece: "el",
    czech_republic: "cs",
    romania: "ro",
    hungary: "hu",
    thailand: "th",
    vietnam: "vi",
    malaysia: "ms",
    indonesia: "id",
    philippines: "en",
    pakistan: "ur",
    bangladesh: "bn",
    colombia: "es",
    chile: "es",
    peru: "es",
    venezuela: "es",
  };

  for (const [key, lang] of Object.entries(countryLanguageMap)) {
    if (countryLower.includes(key)) {
      return lang;
    }
  }

  return "en";
}

