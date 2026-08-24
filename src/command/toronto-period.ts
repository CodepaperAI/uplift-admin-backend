export const COMMAND_TIME_ZONE = "America/Toronto";

function timeZoneOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMMAND_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const representedUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return representedUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function torontoLocalMidnightUtc(
  year: number,
  monthIndex: number,
  day: number,
): Date {
  const localAsUtc = Date.UTC(year, monthIndex, day);
  let candidate = new Date(localAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    candidate = new Date(localAsUtc - timeZoneOffsetMs(candidate));
  }
  return candidate;
}

function parseCommandDay(day: string): {
  year: number;
  monthIndex: number;
  dayOfMonth: number;
} {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(day);
  if (!match) throw new Error("Day must use YYYY-MM-DD format");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const dayOfMonth = Number(match[3]);
  const calendarCheck = new Date(Date.UTC(year, monthIndex, dayOfMonth));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== monthIndex ||
    calendarCheck.getUTCDate() !== dayOfMonth
  ) {
    throw new Error("Day must be a real calendar date");
  }
  return { year, monthIndex, dayOfMonth };
}

export function commandDayForDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMMAND_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not resolve Toronto day");
  return `${year}-${month}-${day}`;
}

export function shiftCommandDay(day: string, offsetDays: number): string {
  if (!Number.isInteger(offsetDays)) {
    throw new Error("Day offset must be an integer");
  }
  const { year, monthIndex, dayOfMonth } = parseCommandDay(day);
  const shifted = new Date(Date.UTC(year, monthIndex, dayOfMonth + offsetDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

export function commandDayRange(from: string, to: string): {
  from: string;
  to: string;
  start: Date;
  end: Date;
  dayCount: number;
  timeZone: typeof COMMAND_TIME_ZONE;
} {
  const fromParts = parseCommandDay(from);
  const toParts = parseCommandDay(to);
  const fromCalendar = Date.UTC(
    fromParts.year,
    fromParts.monthIndex,
    fromParts.dayOfMonth,
  );
  const toCalendar = Date.UTC(
    toParts.year,
    toParts.monthIndex,
    toParts.dayOfMonth,
  );
  if (toCalendar < fromCalendar) throw new Error("to must not precede from");
  return {
    from,
    to,
    start: torontoLocalMidnightUtc(
      fromParts.year,
      fromParts.monthIndex,
      fromParts.dayOfMonth,
    ),
    end: torontoLocalMidnightUtc(
      toParts.year,
      toParts.monthIndex,
      toParts.dayOfMonth + 1,
    ),
    dayCount: Math.floor((toCalendar - fromCalendar) / 86_400_000) + 1,
    timeZone: COMMAND_TIME_ZONE,
  };
}

export function commandDays(from: string, to: string): string[] {
  const range = commandDayRange(from, to);
  if (range.dayCount > 10_000) throw new Error("Day range is too large");
  return Array.from({ length: range.dayCount }, (_, index) =>
    shiftCommandDay(from, index),
  );
}

export function commandMonthRange(month: string): {
  month: string;
  start: Date;
  end: Date;
  timeZone: typeof COMMAND_TIME_ZONE;
} {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error("Month must use YYYY-MM format");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    month,
    start: torontoLocalMidnightUtc(year, monthIndex, 1),
    end: torontoLocalMidnightUtc(year, monthIndex + 1, 1),
    timeZone: COMMAND_TIME_ZONE,
  };
}

export function currentCommandMonth(now = new Date()): string {
  return commandMonthForDate(now);
}

export function commandMonthForDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMMAND_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not resolve Toronto month");
  return `${year}-${month}`;
}

export function commandMonthsEndingAt(month: string, count: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 120) {
    throw new Error("Month count must be an integer from 1 to 120");
  }
  const range = commandMonthRange(month);
  const [year, monthNumber] = range.month.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(Date.UTC(year!, monthNumber! - 1 - index, 1));
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}
