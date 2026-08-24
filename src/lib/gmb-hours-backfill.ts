import type { Prisma } from "@prisma/client";

import { prisma } from "../config/db.config";

const DAY_TO_INDEX: Record<string, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export type ParsedHoursRow = {
  dayOfWeek: number;
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
  is24Hours: boolean;
  segmentOrder: number;
};

export type ParsedSpecialHoursRow = {
  date: Date;
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
  is24Hours: boolean;
  label: string | null;
};

export type ParsedCategoryRow = {
  categoryId: string;
  displayName: string;
  isPrimary: boolean;
  order: number;
};

export type ParsedAttributeRow = {
  attributeId: string;
  displayName: string;
  valueType: "BOOL" | "ENUM" | "URL" | "REPEATED_ENUM";
  boolValue: boolean | null;
  enumValue: string | null;
  urlValue: string | null;
  enumValues: string[];
};

export type ParseError = {
  field: string;
  reason: string;
  rawValue: unknown;
};

export type ParseResult<T> = { rows: T[]; errors: ParseError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTime(timeOfDay: unknown): string | null {
  if (!isRecord(timeOfDay)) return null;
  const hoursRaw = timeOfDay.hours;
  const minutesRaw = timeOfDay.minutes;
  const hours = typeof hoursRaw === "number" ? hoursRaw : 0;
  const minutes = typeof minutesRaw === "number" ? minutesRaw : 0;
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59) return null;
  if (hours === 24 && minutes === 0) return "24:00";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function isMidnight(time: string | null): boolean {
  return time === "00:00";
}

function isEndOfDay(time: string | null): boolean {
  return time === "24:00" || time === "00:00";
}

export function parseRegularHours(hoursJson: unknown): ParseResult<ParsedHoursRow> {
  const result: ParseResult<ParsedHoursRow> = { rows: [], errors: [] };
  if (hoursJson == null) return result;
  if (!isRecord(hoursJson)) {
    result.errors.push({ field: "hoursJson", reason: "not_an_object", rawValue: hoursJson });
    return result;
  }
  const periods = hoursJson.periods;
  if (!Array.isArray(periods)) {
    result.errors.push({ field: "hoursJson.periods", reason: "not_an_array", rawValue: periods });
    return result;
  }

  const byDay = new Map<number, ParsedHoursRow[]>();

  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    if (!isRecord(p)) {
      result.errors.push({ field: `periods[${i}]`, reason: "not_an_object", rawValue: p });
      continue;
    }
    const openDay = typeof p.openDay === "string" ? p.openDay.toUpperCase() : null;
    const dayOfWeek = openDay ? DAY_TO_INDEX[openDay] : undefined;
    if (dayOfWeek === undefined) {
      result.errors.push({
        field: `periods[${i}].openDay`,
        reason: "unknown_day",
        rawValue: p.openDay,
      });
      continue;
    }
    const openTime = formatTime(p.openTime);
    const closeTime = formatTime(p.closeTime);

    const is24Hours =
      isMidnight(openTime) &&
      (isEndOfDay(closeTime) || closeTime === null) &&
      (p.closeDay == null || p.closeDay === p.openDay);

    const row: ParsedHoursRow = {
      dayOfWeek,
      openTime: is24Hours ? null : openTime,
      closeTime: is24Hours ? null : closeTime,
      isClosed: false,
      is24Hours,
      segmentOrder: 0,
    };

    const existing = byDay.get(dayOfWeek) ?? [];
    existing.push(row);
    byDay.set(dayOfWeek, existing);
  }

  for (const [dayOfWeek, rows] of byDay.entries()) {
    rows.sort((a, b) => (a.openTime ?? "").localeCompare(b.openTime ?? ""));
    rows.forEach((row, idx) => {
      row.segmentOrder = idx;
      result.rows.push(row);
    });
    void dayOfWeek;
  }

  return result;
}

function parseDateRecord(value: unknown): Date | null {
  if (!isRecord(value)) return null;
  const year = typeof value.year === "number" ? value.year : null;
  const month = typeof value.month === "number" ? value.month : null;
  const day = typeof value.day === "number" ? value.day : null;
  if (year == null || month == null || day == null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function parseSpecialHours(
  specialHoursJson: unknown,
): ParseResult<ParsedSpecialHoursRow> {
  const result: ParseResult<ParsedSpecialHoursRow> = { rows: [], errors: [] };
  if (specialHoursJson == null) return result;
  if (!isRecord(specialHoursJson)) {
    result.errors.push({
      field: "specialHoursJson",
      reason: "not_an_object",
      rawValue: specialHoursJson,
    });
    return result;
  }
  const periods = specialHoursJson.specialHourPeriods;
  if (periods == null) return result;
  if (!Array.isArray(periods)) {
    result.errors.push({
      field: "specialHoursJson.specialHourPeriods",
      reason: "not_an_array",
      rawValue: periods,
    });
    return result;
  }

  const seenDates = new Set<string>();

  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    if (!isRecord(p)) {
      result.errors.push({
        field: `specialHourPeriods[${i}]`,
        reason: "not_an_object",
        rawValue: p,
      });
      continue;
    }
    const date = parseDateRecord(p.startDate);
    if (!date) {
      result.errors.push({
        field: `specialHourPeriods[${i}].startDate`,
        reason: "invalid_date",
        rawValue: p.startDate,
      });
      continue;
    }
    const dateKey = date.toISOString();
    if (seenDates.has(dateKey)) continue;
    seenDates.add(dateKey);

    const isClosed = p.closed === true;
    const openTime = isClosed ? null : formatTime(p.openTime);
    const closeTime = isClosed ? null : formatTime(p.closeTime);
    const is24Hours =
      !isClosed &&
      isMidnight(openTime) &&
      (isEndOfDay(closeTime) || closeTime === null);

    result.rows.push({
      date,
      openTime: is24Hours ? null : openTime,
      closeTime: is24Hours ? null : closeTime,
      isClosed,
      is24Hours,
      label: typeof p.summary === "string" ? p.summary.slice(0, 200) : null,
    });
  }

  return result;
}

function normalizeCategoryId(name: string | undefined | null): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("categories/")) return trimmed.slice("categories/".length);
  return trimmed;
}

export function parseCategories(
  categoriesJson: unknown,
  profileJson?: unknown,
): ParseResult<ParsedCategoryRow> {
  const result: ParseResult<ParsedCategoryRow> = { rows: [], errors: [] };

  type CategoryRecord = { displayName?: unknown; name?: unknown };
  let primary: CategoryRecord | null = null;
  let additional: CategoryRecord[] = [];

  if (isRecord(profileJson) && isRecord(profileJson.categories)) {
    if (isRecord(profileJson.categories.primaryCategory)) {
      primary = profileJson.categories.primaryCategory as CategoryRecord;
    }
    const add = profileJson.categories.additionalCategories;
    if (Array.isArray(add)) {
      additional = add.filter(isRecord) as CategoryRecord[];
    }
  }

  if (!primary && Array.isArray(categoriesJson)) {
    const items = categoriesJson.filter(isRecord) as CategoryRecord[];
    const first = items[0];
    if (first) {
      primary = first;
      additional = items.slice(1);
    }
  }

  const seen = new Set<string>();
  if (primary) {
    const categoryId = normalizeCategoryId(primary.name as string | undefined);
    const displayName =
      typeof primary.displayName === "string" ? primary.displayName.trim() : null;
    if (categoryId && displayName) {
      seen.add(categoryId);
      result.rows.push({ categoryId, displayName, isPrimary: true, order: 0 });
    } else if (displayName) {
      const fallbackId = displayName.toLowerCase().replace(/\s+/g, "_");
      seen.add(fallbackId);
      result.rows.push({ categoryId: fallbackId, displayName, isPrimary: true, order: 0 });
    } else {
      result.errors.push({
        field: "primaryCategory",
        reason: "missing_display_name",
        rawValue: primary,
      });
    }
  }

  additional.forEach((cat, idx) => {
    const categoryId = normalizeCategoryId(cat.name as string | undefined);
    const displayName =
      typeof cat.displayName === "string" ? cat.displayName.trim() : null;
    if (!displayName) {
      result.errors.push({
        field: `additionalCategories[${idx}]`,
        reason: "missing_display_name",
        rawValue: cat,
      });
      return;
    }
    const id = categoryId || displayName.toLowerCase().replace(/\s+/g, "_");
    if (seen.has(id)) return;
    seen.add(id);
    result.rows.push({ categoryId: id, displayName, isPrimary: false, order: idx + 1 });
  });

  return result;
}

function humanizeAttributeId(id: string): string {
  const base = id.includes("/") ? (id.split("/").pop() ?? id) : id;
  return base
    .replace(/^has_/, "")
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const VALID_VALUE_TYPES = new Set(["BOOL", "ENUM", "URL", "REPEATED_ENUM"]);

export function parseAttributes(attributesJson: unknown): ParseResult<ParsedAttributeRow> {
  const result: ParseResult<ParsedAttributeRow> = { rows: [], errors: [] };
  if (attributesJson == null) return result;

  let items: unknown[];
  if (Array.isArray(attributesJson)) {
    items = attributesJson;
  } else if (isRecord(attributesJson) && Array.isArray(attributesJson.attributes)) {
    items = attributesJson.attributes;
  } else {
    result.errors.push({
      field: "attributesJson",
      reason: "not_a_recognized_shape",
      rawValue: attributesJson,
    });
    return result;
  }

  const seen = new Set<string>();

  for (let i = 0; i < items.length; i += 1) {
    const a = items[i];
    if (!isRecord(a)) {
      result.errors.push({ field: `attributes[${i}]`, reason: "not_an_object", rawValue: a });
      continue;
    }
    const rawId =
      (typeof a.attributeId === "string" && a.attributeId.trim()) ||
      (typeof a.name === "string" && a.name.trim()) ||
      null;
    if (!rawId) {
      result.errors.push({ field: `attributes[${i}].attributeId`, reason: "missing", rawValue: a });
      continue;
    }
    const attributeId = rawId.startsWith("categories/")
      ? (rawId.split("/").pop() ?? rawId)
      : rawId;
    if (seen.has(attributeId)) continue;
    seen.add(attributeId);

    const valueType =
      typeof a.valueType === "string" && VALID_VALUE_TYPES.has(a.valueType)
        ? (a.valueType as ParsedAttributeRow["valueType"])
        : "BOOL";

    const row: ParsedAttributeRow = {
      attributeId,
      displayName: humanizeAttributeId(attributeId),
      valueType,
      boolValue: null,
      enumValue: null,
      urlValue: null,
      enumValues: [],
    };

    const values = Array.isArray(a.values) ? a.values : [];
    switch (valueType) {
      case "BOOL":
        row.boolValue = values[0] === true;
        break;
      case "ENUM":
        row.enumValue = typeof values[0] === "string" ? values[0] : null;
        break;
      case "URL": {
        const uriValues = Array.isArray(a.uriValues) ? a.uriValues : [];
        const first = uriValues[0];
        if (isRecord(first) && typeof first.uri === "string") row.urlValue = first.uri;
        else if (typeof values[0] === "string") row.urlValue = values[0];
        break;
      }
      case "REPEATED_ENUM": {
        const repeated = isRecord(a.repeatedEnumValue) ? a.repeatedEnumValue : null;
        const setValues =
          repeated && Array.isArray(repeated.setValues) ? repeated.setValues : values;
        row.enumValues = setValues.filter((v): v is string => typeof v === "string");
        break;
      }
    }

    result.rows.push(row);
  }

  return result;
}

export type BackfillSummary = {
  businessId: string;
  gmbId: string;
  hoursWritten: number;
  specialHoursWritten: number;
  categoriesWritten: number;
  attributesWritten: number;
  errors: ParseError[];
  skipped?: string;
};

export async function backfillStructuredDataForBusiness(
  businessId: string,
  options: { force?: boolean } = {},
): Promise<BackfillSummary> {
  const snapshot = await prisma.gMBProfileSnapshot.findFirst({
    where: { businessId },
    orderBy: { syncedAt: "desc" },
    select: {
      gmbId: true,
      hoursJson: true,
      specialHoursJson: true,
      categoriesJson: true,
      attributesJson: true,
      profileJson: true,
    },
  });

  if (!snapshot) {
    return {
      businessId,
      gmbId: "",
      hoursWritten: 0,
      specialHoursWritten: 0,
      categoriesWritten: 0,
      attributesWritten: 0,
      errors: [],
      skipped: "no_snapshot",
    };
  }

  if (!options.force) {
    const existingCount = await prisma.gMBBusinessHours.count({ where: { businessId } });
    if (existingCount > 0) {
      return {
        businessId,
        gmbId: snapshot.gmbId,
        hoursWritten: 0,
        specialHoursWritten: 0,
        categoriesWritten: 0,
        attributesWritten: 0,
        errors: [],
        skipped: "already_backfilled",
      };
    }
  }

  const hours = parseRegularHours(snapshot.hoursJson);
  const specialHours = parseSpecialHours(snapshot.specialHoursJson);
  const categories = parseCategories(snapshot.categoriesJson, snapshot.profileJson);
  const attributes = parseAttributes(snapshot.attributesJson);

  const allErrors = [
    ...hours.errors,
    ...specialHours.errors,
    ...categories.errors,
    ...attributes.errors,
  ];

  if (allErrors.length > 0) {
    console.warn(
      `[gmb-backfill] businessId=${businessId} produced ${allErrors.length} parse errors`,
      allErrors.slice(0, 5),
    );
  }

  await prisma.$transaction([
    prisma.gMBBusinessHours.deleteMany({ where: { businessId } }),
    prisma.gMBSpecialHours.deleteMany({ where: { businessId } }),
    prisma.gMBCategory.deleteMany({ where: { businessId } }),
    prisma.gMBAttribute.deleteMany({ where: { businessId } }),
    ...(hours.rows.length > 0
      ? [
          prisma.gMBBusinessHours.createMany({
            data: hours.rows.map((r) => ({ ...r, businessId, gmbId: snapshot.gmbId })),
          }),
        ]
      : []),
    ...(specialHours.rows.length > 0
      ? [
          prisma.gMBSpecialHours.createMany({
            data: specialHours.rows.map((r) => ({ ...r, businessId, gmbId: snapshot.gmbId })),
          }),
        ]
      : []),
    ...(categories.rows.length > 0
      ? [
          prisma.gMBCategory.createMany({
            data: categories.rows.map((r) => ({ ...r, businessId, gmbId: snapshot.gmbId })),
          }),
        ]
      : []),
    ...(attributes.rows.length > 0
      ? [
          prisma.gMBAttribute.createMany({
            data: attributes.rows.map((r) => ({ ...r, businessId, gmbId: snapshot.gmbId })),
          }),
        ]
      : []),
  ]);

  return {
    businessId,
    gmbId: snapshot.gmbId,
    hoursWritten: hours.rows.length,
    specialHoursWritten: specialHours.rows.length,
    categoriesWritten: categories.rows.length,
    attributesWritten: attributes.rows.length,
    errors: allErrors,
  };
}

export async function backfillStructuredDataFromProfile(
  businessId: string,
  gmbId: string,
  profile: {
    regularHours?: unknown;
    specialHours?: unknown;
    categories?: unknown;
    attributes?: unknown;
  },
): Promise<BackfillSummary> {
  const hours = parseRegularHours(profile.regularHours);
  const specialHours = parseSpecialHours(profile.specialHours);
  const categories = parseCategories(null, { categories: profile.categories } as Prisma.JsonObject);
  const attributes = parseAttributes(profile.attributes);

  const allErrors = [
    ...hours.errors,
    ...specialHours.errors,
    ...categories.errors,
    ...attributes.errors,
  ];

  if (allErrors.length > 0) {
    console.warn(
      `[gmb-backfill] businessId=${businessId} produced ${allErrors.length} parse errors`,
      allErrors.slice(0, 5),
    );
  }

  await prisma.$transaction([
    prisma.gMBBusinessHours.deleteMany({ where: { businessId } }),
    prisma.gMBSpecialHours.deleteMany({ where: { businessId } }),
    prisma.gMBCategory.deleteMany({ where: { businessId } }),
    prisma.gMBAttribute.deleteMany({ where: { businessId } }),
    ...(hours.rows.length > 0
      ? [
          prisma.gMBBusinessHours.createMany({
            data: hours.rows.map((r) => ({ ...r, businessId, gmbId })),
          }),
        ]
      : []),
    ...(specialHours.rows.length > 0
      ? [
          prisma.gMBSpecialHours.createMany({
            data: specialHours.rows.map((r) => ({ ...r, businessId, gmbId })),
          }),
        ]
      : []),
    ...(categories.rows.length > 0
      ? [
          prisma.gMBCategory.createMany({
            data: categories.rows.map((r) => ({ ...r, businessId, gmbId })),
          }),
        ]
      : []),
    ...(attributes.rows.length > 0
      ? [
          prisma.gMBAttribute.createMany({
            data: attributes.rows.map((r) => ({ ...r, businessId, gmbId })),
          }),
        ]
      : []),
  ]);

  return {
    businessId,
    gmbId,
    hoursWritten: hours.rows.length,
    specialHoursWritten: specialHours.rows.length,
    categoriesWritten: categories.rows.length,
    attributesWritten: attributes.rows.length,
    errors: allErrors,
  };
}
