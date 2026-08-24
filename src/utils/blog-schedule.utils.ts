type BusinessScheduleContext = {
  defaultLocale?: string | null;
  businessCountry?: string | null;
  businessState?: string | null;
  businessCity?: string | null;
};

type ScheduleEvaluationInput = BusinessScheduleContext & {
  publishDate?: string | Date | null;
  publishTime?: string | null;
  now?: Date;
};

type LocalScheduleSnapshot = {
  date: string;
  time: string;
  timeWithSeconds: string;
  timeZone: string;
  source: string;
};

export type ScheduleDueEvaluation = LocalScheduleSnapshot & {
  publishDate: string | null;
  publishTime: string;
  isDue: boolean;
};

const SINGLE_TIMEZONE_BY_COUNTRY: Record<string, string> = {
  AE: "Asia/Dubai",
  AT: "Europe/Vienna",
  BE: "Europe/Brussels",
  BH: "Asia/Bahrain",
  CH: "Europe/Zurich",
  CN: "Asia/Shanghai",
  CZ: "Europe/Prague",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  ES: "Europe/Madrid",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  HK: "Asia/Hong_Kong",
  IE: "Europe/Dublin",
  IN: "Asia/Kolkata",
  IT: "Europe/Rome",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  KW: "Asia/Kuwait",
  MX: "America/Mexico_City",
  MY: "Asia/Kuala_Lumpur",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  NZ: "Pacific/Auckland",
  OM: "Asia/Muscat",
  PH: "Asia/Manila",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  QA: "Asia/Qatar",
  SA: "Asia/Riyadh",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  TH: "Asia/Bangkok",
  TR: "Europe/Istanbul",
  TW: "Asia/Taipei",
  UA: "Europe/Kyiv",
  VN: "Asia/Ho_Chi_Minh",
  ZA: "Africa/Johannesburg",
};

const COUNTRY_DEFAULT_TIMEZONE: Record<string, string> = {
  AU: "Australia/Perth",
  BR: "America/Sao_Paulo",
  CA: "America/Toronto",
  ID: "Asia/Jakarta",
  RU: "Europe/Moscow",
  US: "America/Los_Angeles",
};

const US_STATE_TIMEZONE: Record<string, string> = {
  AL: "America/Chicago",
  ALABAMA: "America/Chicago",
  AK: "America/Anchorage",
  ALASKA: "America/Anchorage",
  AZ: "America/Phoenix",
  ARIZONA: "America/Phoenix",
  AR: "America/Chicago",
  ARKANSAS: "America/Chicago",
  CA: "America/Los_Angeles",
  CALIFORNIA: "America/Los_Angeles",
  CO: "America/Denver",
  COLORADO: "America/Denver",
  CT: "America/New_York",
  CONNECTICUT: "America/New_York",
  DE: "America/New_York",
  DELAWARE: "America/New_York",
  FL: "America/New_York",
  FLORIDA: "America/New_York",
  GA: "America/New_York",
  GEORGIA: "America/New_York",
  HI: "Pacific/Honolulu",
  HAWAII: "Pacific/Honolulu",
  ID: "America/Denver",
  IDAHO: "America/Denver",
  IL: "America/Chicago",
  ILLINOIS: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  INDIANA: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  IOWA: "America/Chicago",
  KS: "America/Chicago",
  KANSAS: "America/Chicago",
  KY: "America/New_York",
  KENTUCKY: "America/New_York",
  LA: "America/Chicago",
  LOUISIANA: "America/Chicago",
  ME: "America/New_York",
  MAINE: "America/New_York",
  MD: "America/New_York",
  MARYLAND: "America/New_York",
  MA: "America/New_York",
  MASSACHUSETTS: "America/New_York",
  MI: "America/Detroit",
  MICHIGAN: "America/Detroit",
  MN: "America/Chicago",
  MINNESOTA: "America/Chicago",
  MS: "America/Chicago",
  MISSISSIPPI: "America/Chicago",
  MO: "America/Chicago",
  MISSOURI: "America/Chicago",
  MT: "America/Denver",
  MONTANA: "America/Denver",
  NE: "America/Chicago",
  NEBRASKA: "America/Chicago",
  NV: "America/Los_Angeles",
  NEVADA: "America/Los_Angeles",
  NH: "America/New_York",
  "NEW HAMPSHIRE": "America/New_York",
  NJ: "America/New_York",
  "NEW JERSEY": "America/New_York",
  NM: "America/Denver",
  "NEW MEXICO": "America/Denver",
  NY: "America/New_York",
  "NEW YORK": "America/New_York",
  NC: "America/New_York",
  "NORTH CAROLINA": "America/New_York",
  ND: "America/Chicago",
  "NORTH DAKOTA": "America/Chicago",
  OH: "America/New_York",
  OHIO: "America/New_York",
  OK: "America/Chicago",
  OKLAHOMA: "America/Chicago",
  OR: "America/Los_Angeles",
  OREGON: "America/Los_Angeles",
  PA: "America/New_York",
  PENNSYLVANIA: "America/New_York",
  RI: "America/New_York",
  "RHODE ISLAND": "America/New_York",
  SC: "America/New_York",
  "SOUTH CAROLINA": "America/New_York",
  SD: "America/Chicago",
  "SOUTH DAKOTA": "America/Chicago",
  TN: "America/Chicago",
  TENNESSEE: "America/Chicago",
  TX: "America/Chicago",
  TEXAS: "America/Chicago",
  UT: "America/Denver",
  UTAH: "America/Denver",
  VT: "America/New_York",
  VERMONT: "America/New_York",
  VA: "America/New_York",
  VIRGINIA: "America/New_York",
  WA: "America/Los_Angeles",
  WASHINGTON: "America/Los_Angeles",
  WV: "America/New_York",
  "WEST VIRGINIA": "America/New_York",
  WI: "America/Chicago",
  WISCONSIN: "America/Chicago",
  WY: "America/Denver",
  WYOMING: "America/Denver",
  DC: "America/New_York",
  "DISTRICT OF COLUMBIA": "America/New_York",
};

const CANADA_PROVINCE_TIMEZONE: Record<string, string> = {
  AB: "America/Edmonton",
  ALBERTA: "America/Edmonton",
  BC: "America/Vancouver",
  "BRITISH COLUMBIA": "America/Vancouver",
  MB: "America/Winnipeg",
  MANITOBA: "America/Winnipeg",
  NB: "America/Moncton",
  "NEW BRUNSWICK": "America/Moncton",
  NL: "America/St_Johns",
  "NEWFOUNDLAND AND LABRADOR": "America/St_Johns",
  NS: "America/Halifax",
  "NOVA SCOTIA": "America/Halifax",
  NT: "America/Yellowknife",
  "NORTHWEST TERRITORIES": "America/Yellowknife",
  NU: "America/Iqaluit",
  NUNAVUT: "America/Iqaluit",
  ON: "America/Toronto",
  ONTARIO: "America/Toronto",
  PE: "America/Halifax",
  "PRINCE EDWARD ISLAND": "America/Halifax",
  QC: "America/Toronto",
  QUEBEC: "America/Toronto",
  SK: "America/Regina",
  SASKATCHEWAN: "America/Regina",
  YT: "America/Whitehorse",
  YUKON: "America/Whitehorse",
};

const AUSTRALIA_STATE_TIMEZONE: Record<string, string> = {
  ACT: "Australia/Sydney",
  "AUSTRALIAN CAPITAL TERRITORY": "Australia/Sydney",
  NSW: "Australia/Sydney",
  "NEW SOUTH WALES": "Australia/Sydney",
  NT: "Australia/Darwin",
  "NORTHERN TERRITORY": "Australia/Darwin",
  QLD: "Australia/Brisbane",
  QUEENSLAND: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  "SOUTH AUSTRALIA": "Australia/Adelaide",
  TAS: "Australia/Hobart",
  TASMANIA: "Australia/Hobart",
  VIC: "Australia/Melbourne",
  VICTORIA: "Australia/Melbourne",
  WA: "Australia/Perth",
  "WESTERN AUSTRALIA": "Australia/Perth",
};

const CITY_TIMEZONE: Record<string, string> = {
  ATLANTA: "America/New_York",
  AUSTIN: "America/Chicago",
  BANGALORE: "Asia/Kolkata",
  BARCELONA: "Europe/Madrid",
  BOSTON: "America/New_York",
  BRAMPTON: "America/Toronto",
  BRISBANE: "Australia/Brisbane",
  CALGARY: "America/Edmonton",
  CHICAGO: "America/Chicago",
  DALLAS: "America/Chicago",
  DENVER: "America/Denver",
  DUBAI: "Asia/Dubai",
  EDMONTON: "America/Edmonton",
  HALIFAX: "America/Halifax",
  HOUSTON: "America/Chicago",
  LONDON: "Europe/London",
  "LOS ANGELES": "America/Los_Angeles",
  MELBOURNE: "Australia/Melbourne",
  MIAMI: "America/New_York",
  MISSISSAUGA: "America/Toronto",
  MONTREAL: "America/Toronto",
  "NEW YORK": "America/New_York",
  OTTAWA: "America/Toronto",
  PHOENIX: "America/Phoenix",
  PORTLAND: "America/Los_Angeles",
  "SAN DIEGO": "America/Los_Angeles",
  "SAN FRANCISCO": "America/Los_Angeles",
  SEATTLE: "America/Los_Angeles",
  SINGAPORE: "Asia/Singapore",
  SYDNEY: "Australia/Sydney",
  TOKYO: "Asia/Tokyo",
  TORONTO: "America/Toronto",
  VANCOUVER: "America/Vancouver",
  WINNIPEG: "America/Winnipeg",
};

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  AUSTRALIA: "AU",
  BRAZIL: "BR",
  CANADA: "CA",
  CHINA: "CN",
  FRANCE: "FR",
  GERMANY: "DE",
  INDIA: "IN",
  JAPAN: "JP",
  MEXICO: "MX",
  "NEW ZEALAND": "NZ",
  SINGAPORE: "SG",
  "SOUTH AFRICA": "ZA",
  SPAIN: "ES",
  UAE: "AE",
  UK: "GB",
  "UNITED ARAB EMIRATES": "AE",
  "UNITED KINGDOM": "GB",
  "UNITED STATES": "US",
  USA: "US",
  US: "US",
};

function normalizeKey(value?: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function normalizeCountryCode(value?: string | null): string | null {
  const normalized = normalizeKey(value);
  if (!normalized) return null;

  if (/^[A-Z]{2}$/.test(normalized)) {
    return normalized;
  }

  return COUNTRY_NAME_TO_CODE[normalized] ?? null;
}

function extractLocaleCountryCode(defaultLocale?: string | null): string | null {
  if (!defaultLocale) return null;
  const match = defaultLocale.trim().match(/[-_]([A-Za-z]{2})$/);
  return match ? match[1]!.toUpperCase() : null;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function inferBusinessTimeZone(
  context: BusinessScheduleContext,
): { timeZone: string; source: string } {
  const localeCountry = extractLocaleCountryCode(context.defaultLocale);
  const country = normalizeCountryCode(context.businessCountry) ?? localeCountry;
  const state = normalizeKey(context.businessState);
  const city = normalizeKey(context.businessCity);

  const tryResolved = (timeZone?: string | null, source?: string) => {
    if (!timeZone || !source || !isValidTimeZone(timeZone)) {
      return null;
    }

    return { timeZone, source };
  };

  if (country === "US" && state) {
    const resolved = tryResolved(
      US_STATE_TIMEZONE[state],
      `state:${state}`,
    );
    if (resolved) return resolved;

    // Retry with first token only (handles "CA 90210" → "CA")
    const firstToken = state.split(" ")[0];
    if (firstToken && firstToken !== state) {
      const retryResolved = tryResolved(
        US_STATE_TIMEZONE[firstToken],
        `state-prefix:${firstToken}`,
      );
      if (retryResolved) return retryResolved;
    }
  }

  if (country === "CA" && state) {
    const resolved = tryResolved(
      CANADA_PROVINCE_TIMEZONE[state],
      `province:${state}`,
    );
    if (resolved) return resolved;

    // Retry with first token only (handles "ON L5T2L8" → "ON")
    const firstToken = state.split(" ")[0];
    if (firstToken && firstToken !== state) {
      const retryResolved = tryResolved(
        CANADA_PROVINCE_TIMEZONE[firstToken],
        `province-prefix:${firstToken}`,
      );
      if (retryResolved) return retryResolved;
    }
  }

  if (country === "AU" && state) {
    const resolved = tryResolved(
      AUSTRALIA_STATE_TIMEZONE[state],
      `state:${state}`,
    );
    if (resolved) return resolved;
  }

  if (city) {
    const resolved = tryResolved(CITY_TIMEZONE[city], `city:${city}`);
    if (resolved) return resolved;
  }

  if (country) {
    const singleCountry = tryResolved(
      SINGLE_TIMEZONE_BY_COUNTRY[country],
      `country:${country}`,
    );
    if (singleCountry) return singleCountry;

    const fallbackCountry = tryResolved(
      COUNTRY_DEFAULT_TIMEZONE[country],
      `country-default:${country}`,
    );
    if (fallbackCountry) return fallbackCountry;
  }

  if (localeCountry) {
    const localeResolved = tryResolved(
      SINGLE_TIMEZONE_BY_COUNTRY[localeCountry] ??
        COUNTRY_DEFAULT_TIMEZONE[localeCountry],
      `locale:${localeCountry}`,
    );
    if (localeResolved) return localeResolved;
  }

  return {
    timeZone: "Etc/UTC",
    source: "fallback:UTC",
  };
}

function getFormatterParts(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return formatter.formatToParts(now);
}

export function getBusinessLocalScheduleSnapshot(
  context: BusinessScheduleContext,
  now: Date = new Date(),
): LocalScheduleSnapshot {
  const { timeZone, source } = inferBusinessTimeZone(context);
  const parts = getFormatterParts(now, timeZone);
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";

  const year = getPart("year");
  const month = getPart("month");
  const day = getPart("day");
  const hour = getPart("hour");
  const minute = getPart("minute");
  const second = getPart("second");

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    timeWithSeconds: `${hour}:${minute}:${second}`,
    timeZone,
    source,
  };
}

export function normalizeScheduleDate(
  value?: string | Date | null,
): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().split("T")[0] ?? null;
    }

    return null;
  }

  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString().split("T")[0] ?? null;
}

export function normalizeScheduleTime(value?: string | null): string {
  if (!value) {
    return "00:00";
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return "00:00";
  }

  const hours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "", 10);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return "00:00";
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function evaluateScheduleDue(
  input: ScheduleEvaluationInput,
): ScheduleDueEvaluation {
  const snapshot = getBusinessLocalScheduleSnapshot(input, input.now);
  const publishDate = normalizeScheduleDate(input.publishDate);
  const publishTime = normalizeScheduleTime(input.publishTime);

  let isDue = false;
  if (publishDate) {
    if (publishDate < snapshot.date) {
      isDue = true;
    } else if (publishDate === snapshot.date) {
      isDue = publishTime <= snapshot.time;
    }
  }

  return {
    ...snapshot,
    publishDate,
    publishTime,
    isDue,
  };
}

export function getUtcScheduleQueryCeiling(
  now: Date = new Date(),
  daysAhead = 1,
): string {
  const future = new Date(now);
  future.setUTCDate(future.getUTCDate() + daysAhead);
  return future.toISOString().split("T")[0] ?? "";
}
