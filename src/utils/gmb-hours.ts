/**
 * Structured GMB business hours - validation, diffing, and GBP API serialization.
 *
 * Day-of-week convention used throughout: 0 = Sunday ... 6 = Saturday.
 * This matches Date.prototype.getDay() but NOT the GBP API enum
 * (MONDAY, TUESDAY, ...). Serializer translates.
 */

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const GBP_DAY_ENUM = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export const GMB_MAX_SEGMENTS_PER_DAY = 2;

export type GMBHoursSegment = {
  dayOfWeek: number; // 0-6
  openTime: string | null; // "HH:mm" - null when closed/24h
  closeTime: string | null;
  isClosed: boolean;
  is24Hours: boolean;
  segmentOrder: number; // 0 = primary segment, 1 = second (split hours)
};

export type GMBSpecialHoursEntry = {
  date: string; // ISO date "YYYY-MM-DD"
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
  is24Hours: boolean;
  label: string | null;
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTime(value: string | null | undefined): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

function timeToMinutes(value: string): number {
  const [h = 0, m = 0] = value.split(":").map(Number);
  return h * 60 + m;
}

export type HoursValidationIssue =
  | { code: "invalid_time"; dayOfWeek: number; field: "openTime" | "closeTime"; segmentOrder: number }
  | { code: "missing_time"; dayOfWeek: number; segmentOrder: number }
  | { code: "close_before_open"; dayOfWeek: number; segmentOrder: number }
  | { code: "overlapping_segments"; dayOfWeek: number }
  | { code: "too_many_segments"; dayOfWeek: number; count: number }
  | { code: "duplicate_segment_order"; dayOfWeek: number; segmentOrder: number }
  | { code: "out_of_range_day"; dayOfWeek: number }
  | { code: "closed_and_open"; dayOfWeek: number; segmentOrder: number };

export function validateBusinessHours(segments: GMBHoursSegment[]): HoursValidationIssue[] {
  const issues: HoursValidationIssue[] = [];
  const byDay = new Map<number, GMBHoursSegment[]>();

  for (const seg of segments) {
    if (seg.dayOfWeek < 0 || seg.dayOfWeek > 6 || !Number.isInteger(seg.dayOfWeek)) {
      issues.push({ code: "out_of_range_day", dayOfWeek: seg.dayOfWeek });
      continue;
    }

    if (seg.isClosed && (seg.openTime || seg.closeTime || seg.is24Hours)) {
      issues.push({ code: "closed_and_open", dayOfWeek: seg.dayOfWeek, segmentOrder: seg.segmentOrder });
    }

    if (!seg.isClosed && !seg.is24Hours) {
      if (!seg.openTime || !seg.closeTime) {
        issues.push({ code: "missing_time", dayOfWeek: seg.dayOfWeek, segmentOrder: seg.segmentOrder });
      } else {
        if (!isValidTime(seg.openTime)) {
          issues.push({ code: "invalid_time", dayOfWeek: seg.dayOfWeek, field: "openTime", segmentOrder: seg.segmentOrder });
        }
        if (!isValidTime(seg.closeTime)) {
          issues.push({ code: "invalid_time", dayOfWeek: seg.dayOfWeek, field: "closeTime", segmentOrder: seg.segmentOrder });
        }
        if (isValidTime(seg.openTime) && isValidTime(seg.closeTime)) {
          const open = timeToMinutes(seg.openTime);
          const close = timeToMinutes(seg.closeTime);
          // "00:00" close is treated as midnight end-of-day - allow it.
          if (close !== 0 && close <= open) {
            issues.push({ code: "close_before_open", dayOfWeek: seg.dayOfWeek, segmentOrder: seg.segmentOrder });
          }
        }
      }
    }

    const arr = byDay.get(seg.dayOfWeek) ?? [];
    arr.push(seg);
    byDay.set(seg.dayOfWeek, arr);
  }

  for (const [day, daySegments] of byDay) {
    if (daySegments.length > GMB_MAX_SEGMENTS_PER_DAY) {
      issues.push({ code: "too_many_segments", dayOfWeek: day, count: daySegments.length });
    }

    const orders = new Set<number>();
    for (const s of daySegments) {
      if (orders.has(s.segmentOrder)) {
        issues.push({ code: "duplicate_segment_order", dayOfWeek: day, segmentOrder: s.segmentOrder });
      }
      orders.add(s.segmentOrder);
    }

    const openSegments = daySegments
      .filter((s) => !s.isClosed && !s.is24Hours && isValidTime(s.openTime) && isValidTime(s.closeTime))
      .map((s) => ({
        open: timeToMinutes(s.openTime as string),
        close: timeToMinutes(s.closeTime as string) || 24 * 60, // 00:00 close = end of day
      }))
      .sort((a, b) => a.open - b.open);

    for (let i = 1; i < openSegments.length; i++) {
      const current = openSegments[i];
      const previous = openSegments[i - 1];
      if (current && previous && current.open < previous.close) {
        issues.push({ code: "overlapping_segments", dayOfWeek: day });
        break;
      }
    }
  }

  return issues;
}

/**
 * Returns true if every day 0-6 has either at least one segment or an explicit
 * "closed" marker. Drives the hours_completeness health check.
 */
export function isWeeklyHoursComplete(segments: GMBHoursSegment[]): boolean {
  const seen = new Set<number>();
  for (const seg of segments) {
    if (seg.isClosed || seg.is24Hours || (isValidTime(seg.openTime) && isValidTime(seg.closeTime))) {
      seen.add(seg.dayOfWeek);
    }
  }
  for (let d = 0; d < 7; d++) {
    if (!seen.has(d)) return false;
  }
  return true;
}

/** Empty 7-day grid for the editor's initial state when no hours exist. */
export function emptyHoursGrid(): GMBHoursSegment[] {
  const out: GMBHoursSegment[] = [];
  for (let d = 0; d < 7; d++) {
    out.push({
      dayOfWeek: d,
      openTime: null,
      closeTime: null,
      isClosed: false,
      is24Hours: false,
      segmentOrder: 0,
    });
  }
  return out;
}

/** Sort segments for stable display: day asc, segmentOrder asc. */
export function sortSegments(segments: GMBHoursSegment[]): GMBHoursSegment[] {
  return segments.slice().sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
    return a.segmentOrder - b.segmentOrder;
  });
}

/** Diff for the approval card. Reports per-day human-readable changes. */
export type HoursDiffEntry = {
  dayOfWeek: number;
  previousLabel: string;
  proposedLabel: string;
};

function formatSegmentsForDay(daySegments: GMBHoursSegment[]): string {
  const visible = daySegments.filter((s) => !s.isClosed);
  if (visible.length === 0 || daySegments.every((s) => s.isClosed)) return "Closed";
  return visible
    .sort((a, b) => a.segmentOrder - b.segmentOrder)
    .map((s) => {
      if (s.is24Hours) return "Open 24 hours";
      if (isValidTime(s.openTime) && isValidTime(s.closeTime)) {
        return `${s.openTime}–${s.closeTime}`;
      }
      return "—";
    })
    .join(", ");
}

export function diffWeeklyHours(
  current: GMBHoursSegment[],
  proposed: GMBHoursSegment[],
): HoursDiffEntry[] {
  const out: HoursDiffEntry[] = [];
  for (let d = 0; d < 7; d++) {
    const cur = formatSegmentsForDay(current.filter((s) => s.dayOfWeek === d));
    const prop = formatSegmentsForDay(proposed.filter((s) => s.dayOfWeek === d));
    if (cur !== prop) {
      out.push({ dayOfWeek: d, previousLabel: cur, proposedLabel: prop });
    }
  }
  return out;
}

/**
 * Serialize structured weekly hours into the GBP API regularHours.periods shape.
 * Skips closed days. Single-segment day becomes one period. Multi-segment day
 * becomes two periods.
 */
export type GbpHoursPeriod = {
  openDay: string;
  openTime: { hours: number; minutes: number };
  closeDay: string;
  closeTime: { hours: number; minutes: number };
};

export function serializeForGbpPatch(segments: GMBHoursSegment[]): { periods: GbpHoursPeriod[] } {
  const periods: GbpHoursPeriod[] = [];
  for (const s of segments) {
    if (s.isClosed) continue;
    const dayEnum = GBP_DAY_ENUM[s.dayOfWeek];
    if (!dayEnum) continue;
    if (s.is24Hours) {
      periods.push({
        openDay: dayEnum,
        openTime: { hours: 0, minutes: 0 },
        closeDay: dayEnum,
        closeTime: { hours: 24, minutes: 0 },
      });
      continue;
    }
    if (!isValidTime(s.openTime) || !isValidTime(s.closeTime)) continue;
    const [openH = 0, openM = 0] = s.openTime.split(":").map(Number);
    const [closeH = 0, closeM = 0] = s.closeTime.split(":").map(Number);
    periods.push({
      openDay: dayEnum,
      openTime: { hours: openH, minutes: openM },
      closeDay: dayEnum,
      closeTime: { hours: closeH, minutes: closeM },
    });
  }
  return { periods };
}

/**
 * Best-effort parse of an arbitrary stored hours JSON blob into our structured
 * format. Tolerates the GBP shape (periods with openDay/closeDay enums) and a
 * couple of common legacy shapes. Returns parsed segments + an array of
 * messages describing what could not be parsed.
 */
export function parseLegacyHoursJson(input: unknown): {
  segments: GMBHoursSegment[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const segments: GMBHoursSegment[] = [];

  if (!input || typeof input !== "object") {
    warnings.push("Hours JSON missing or not an object");
    return { segments, warnings };
  }

  const obj = input as Record<string, unknown>;

  // Shape A: GBP API style { periods: [{ openDay, openTime, closeDay, closeTime }] }
  const periodsRaw = (obj.periods as unknown) ?? (obj["regularHours"] as Record<string, unknown> | undefined)?.["periods"];
  if (Array.isArray(periodsRaw)) {
    const segmentCountPerDay = new Map<number, number>();
    for (const p of periodsRaw) {
      if (!p || typeof p !== "object") continue;
      const period = p as Record<string, unknown>;
      const dayIdx = GBP_DAY_ENUM.indexOf((period.openDay as string)?.toUpperCase() as (typeof GBP_DAY_ENUM)[number]);
      if (dayIdx < 0) {
        warnings.push(`Unknown openDay value: ${JSON.stringify(period.openDay)}`);
        continue;
      }
      const openTime = period.openTime as { hours?: number; minutes?: number } | undefined;
      const closeTime = period.closeTime as { hours?: number; minutes?: number } | undefined;
      if (!openTime || !closeTime) {
        warnings.push(`Period for day ${dayIdx} missing openTime or closeTime`);
        continue;
      }
      const oh = openTime.hours ?? 0;
      const om = openTime.minutes ?? 0;
      const ch = closeTime.hours ?? 0;
      const cm = closeTime.minutes ?? 0;
      const is24 = oh === 0 && om === 0 && ch === 24 && cm === 0;
      const order = segmentCountPerDay.get(dayIdx) ?? 0;
      segmentCountPerDay.set(dayIdx, order + 1);
      segments.push({
        dayOfWeek: dayIdx,
        openTime: is24 ? null : `${String(oh).padStart(2, "0")}:${String(om).padStart(2, "0")}`,
        closeTime: is24 ? null : `${String(ch % 24).padStart(2, "0")}:${String(cm).padStart(2, "0")}`,
        isClosed: false,
        is24Hours: is24,
        segmentOrder: order,
      });
    }
    return { segments, warnings };
  }

  warnings.push("Hours JSON shape not recognized");
  return { segments, warnings };
}
