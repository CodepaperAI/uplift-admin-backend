import { inferBusinessTimeZone } from "./blog-schedule.utils";

export const SOCIAL_MORNING_WINDOW_START_HOUR = 8 as const;
export const SOCIAL_MORNING_WINDOW_END_HOUR = 9 as const;

type SocialScheduleLocation = {
  configuredTimeZone?: string | null;
  providerTimeZone?: string | null;
  defaultLocale?: string | null;
  businessCountry?: string | null;
  businessState?: string | null;
  businessCity?: string | null;
  geoCountry?: string | null;
  geoState?: string | null;
  geoCity?: string | null;
  serviceAreaLocations?: readonly string[] | null;
};

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

type LocalDateTime = LocalDate & {
  hour: number;
  minute: number;
  second: number;
};

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const CANADIAN_PROVINCE_KEYS = new Set([
  "AB",
  "ALBERTA",
  "BC",
  "BRITISH COLUMBIA",
  "MB",
  "MANITOBA",
  "NB",
  "NEW BRUNSWICK",
  "NL",
  "NEWFOUNDLAND AND LABRADOR",
  "NS",
  "NOVA SCOTIA",
  "NT",
  "NORTHWEST TERRITORIES",
  "NU",
  "NUNAVUT",
  "ON",
  "ONTARIO",
  "PE",
  "PRINCE EDWARD ISLAND",
  "QC",
  "QUEBEC",
  "SK",
  "SASKATCHEWAN",
  "YT",
  "YUKON",
]);

function normalizeLocationKey(value?: string | null): string | null {
  if (!value?.trim()) return null;
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function resolvedInference(
  context: Parameters<typeof inferBusinessTimeZone>[0],
): string | null {
  const inferred = inferBusinessTimeZone(context);
  return inferred.source === "fallback:UTC" ? null : inferred.timeZone;
}

/**
 * Existing rows use UTC as a schema default, not as an explicit user choice.
 * A connected provider and an exact known city are more specific than a
 * previously derived setting or a conflicting legacy province/state value.
 * Otherwise preserve a valid non-default setting before broader inference.
 */
export function resolveSocialScheduleTimeZone(
  input: SocialScheduleLocation,
): string {
  const configured = input.configuredTimeZone?.trim();
  const configuredIsSchemaDefault =
    configured === "UTC" || configured === "Etc/UTC";

  const providerTimeZone = input.providerTimeZone?.trim();
  if (providerTimeZone && isValidTimeZone(providerTimeZone)) {
    return providerTimeZone;
  }

  const geoCityTimeZone = resolvedInference({
    businessCity: input.geoCity,
  });
  if (geoCityTimeZone) return geoCityTimeZone;

  const businessCityTimeZone = resolvedInference({
    businessCity: input.businessCity,
  });
  if (businessCityTimeZone) return businessCityTimeZone;

  if (configured && isValidTimeZone(configured) && !configuredIsSchemaDefault) {
    return configured;
  }

  const geoTimeZone = resolvedInference({
    businessCountry: input.geoCountry,
    businessState: input.geoState,
    businessCity: input.geoCity,
  });
  if (geoTimeZone) return geoTimeZone;

  const businessTimeZone = resolvedInference({
    businessCountry: input.businessCountry,
    businessState: input.businessState,
    businessCity: input.businessCity,
  });
  if (businessTimeZone) return businessTimeZone;

  // Older onboarding rows can have address columns shifted (for example
  // country="ON" or state="ON L7A"). Recover a Canadian province from any
  // location field before falling back to a schema-default locale.
  const locationValues = [
    input.businessCountry,
    input.businessState,
    input.businessCity,
    ...(input.serviceAreaLocations ?? []),
  ];
  for (const value of locationValues) {
    const key = normalizeLocationKey(value);
    if (!key) continue;
    const firstToken = key.split(" ")[0]!;
    const province = CANADIAN_PROVINCE_KEYS.has(key)
      ? key
      : CANADIAN_PROVINCE_KEYS.has(firstToken)
        ? firstToken
        : null;
    if (!province) continue;
    const repaired = resolvedInference({
      businessCountry: "CA",
      businessState: province,
    });
    if (repaired) return repaired;
  }

  for (const city of input.serviceAreaLocations ?? []) {
    const serviceAreaTimeZone = resolvedInference({ businessCity: city });
    if (serviceAreaTimeZone) return serviceAreaTimeZone;
  }

  const localeTimeZone = resolvedInference({
    defaultLocale: input.defaultLocale,
  });
  if (localeTimeZone) return localeTimeZone;

  return configured && isValidTimeZone(configured) ? configured : "Etc/UTC";
}

function formatterParts(date: Date, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDateKey(date: LocalDate): string {
  return [date.year, String(date.month).padStart(2, "0"), String(date.day).padStart(2, "0")].join("-");
}

/** Convert a valid local wall-clock time to its UTC instant without a fixed offset. */
export function socialLocalDateTimeToUtc(
  input: LocalDate & { hour: number; minute: number },
  timeZone: string,
): Date {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid social scheduling timezone: ${timeZone}`);
  }

  const targetAsUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    0,
    0,
  );
  let candidate = new Date(targetAsUtc);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = formatterParts(candidate, timeZone);
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
      0,
    );
    const correction = targetAsUtc - representedAsUtc;
    if (correction === 0) return candidate;
    candidate = new Date(candidate.getTime() + correction);
  }

  const finalParts = formatterParts(candidate, timeZone);
  if (
    finalParts.year !== input.year ||
    finalParts.month !== input.month ||
    finalParts.day !== input.day ||
    finalParts.hour !== input.hour ||
    finalParts.minute !== input.minute
  ) {
    throw new Error("Social local scheduling time could not be resolved");
  }
  return candidate;
}

/**
 * Build ordered topic slots in the next local morning window. Multiple slots
 * on the same date are spread evenly inside 08:00–09:00 instead of colliding.
 */
export function buildSocialSchedule(input: {
  count: number;
  cadencePerWeek: number;
  now?: Date;
  timeZone?: string;
}): Date[] {
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) return [];

  const now = input.now ?? new Date();
  const timeZone = input.timeZone?.trim() || "Etc/UTC";
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid social scheduling timezone: ${timeZone}`);
  }
  const cadence = Math.min(10, Math.max(1, Math.floor(input.cadencePerWeek)));
  const localNow = formatterParts(now, timeZone);
  const firstLocalDate = addLocalDays(localNow, 1);
  const dayOffsets = Array.from({ length: count }, (_, index) =>
    Math.floor((index * 7) / cadence),
  );
  const slotsPerDay = new Map<number, number>();
  for (const dayOffset of dayOffsets) {
    slotsPerDay.set(dayOffset, (slotsPerDay.get(dayOffset) ?? 0) + 1);
  }
  const usedSlotsPerDay = new Map<number, number>();

  return dayOffsets.map((dayOffset) => {
    const slotsToday = slotsPerDay.get(dayOffset) ?? 1;
    const slotIndex = usedSlotsPerDay.get(dayOffset) ?? 0;
    usedSlotsPerDay.set(dayOffset, slotIndex + 1);
    const minute = Math.floor((60 * (slotIndex + 1)) / (slotsToday + 1));
    const localDate = addLocalDays(firstLocalDate, dayOffset);
    const scheduled = socialLocalDateTimeToUtc(
      {
        ...localDate,
        hour: SOCIAL_MORNING_WINDOW_START_HOUR,
        minute,
      },
      timeZone,
    );

    if (scheduled.getTime() <= now.getTime()) {
      throw new Error(
        `Social schedule must be in the future (${localDateKey(localDate)} ${timeZone})`,
      );
    }
    return scheduled;
  });
}

export function socialScheduleLocalParts(
  date: Date,
  timeZone: string,
): LocalDateTime {
  return formatterParts(date, timeZone);
}
