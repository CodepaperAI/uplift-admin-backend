import { describe, expect, it } from "bun:test";

import {
  parseAttributes,
  parseCategories,
  parseRegularHours,
  parseSpecialHours,
} from "../lib/gmb-hours-backfill";

describe("parseRegularHours", () => {
  it("parses a standard weekday 9-5 schedule into 5 rows", () => {
    const input = {
      periods: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((day) => ({
        openDay: day,
        openTime: { hours: 9 },
        closeDay: day,
        closeTime: { hours: 17 },
      })),
    };
    const { rows, errors } = parseRegularHours(input);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.openTime === "09:00" && r.closeTime === "17:00")).toBe(true);
    expect(rows.every((r) => r.segmentOrder === 0 && !r.is24Hours && !r.isClosed)).toBe(true);
    expect(rows.map((r) => r.dayOfWeek).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("detects 24-hour businesses", () => {
    const input = {
      periods: [
        {
          openDay: "MONDAY",
          openTime: { hours: 0, minutes: 0 },
          closeDay: "MONDAY",
          closeTime: { hours: 24, minutes: 0 },
        },
      ],
    };
    const { rows } = parseRegularHours(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is24Hours).toBe(true);
    expect(rows[0]!.openTime).toBeNull();
    expect(rows[0]!.closeTime).toBeNull();
  });

  it("supports split-hour segments on the same day (lunch break)", () => {
    const input = {
      periods: [
        {
          openDay: "MONDAY",
          openTime: { hours: 11 },
          closeDay: "MONDAY",
          closeTime: { hours: 14 },
        },
        {
          openDay: "MONDAY",
          openTime: { hours: 17 },
          closeDay: "MONDAY",
          closeTime: { hours: 22 },
        },
      ],
    };
    const { rows } = parseRegularHours(input);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.segmentOrder).toBe(0);
    expect(rows[1]!.segmentOrder).toBe(1);
    expect(rows[0]!.openTime).toBe("11:00");
    expect(rows[1]!.openTime).toBe("17:00");
  });

  it("returns no rows for an empty / missing input without error", () => {
    expect(parseRegularHours(null)).toEqual({ rows: [], errors: [] });
    expect(parseRegularHours(undefined)).toEqual({ rows: [], errors: [] });
    expect(parseRegularHours({ periods: [] })).toEqual({ rows: [], errors: [] });
  });

  it("records errors for unknown day names and malformed periods", () => {
    const input = {
      periods: [
        { openDay: "FUNDAY", openTime: { hours: 9 }, closeTime: { hours: 17 } },
        "not_an_object",
        { openDay: "MONDAY", openTime: { hours: 9 }, closeTime: { hours: 17 } },
      ],
    };
    const { rows, errors } = parseRegularHours(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dayOfWeek).toBe(1);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.reason === "unknown_day")).toBe(true);
    expect(errors.some((e) => e.reason === "not_an_object")).toBe(true);
  });

  it("rejects entirely wrong shape with one error", () => {
    const { rows, errors } = parseRegularHours("not an object");
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("not_an_object");
  });
});

describe("parseSpecialHours", () => {
  it("parses a closed holiday entry", () => {
    const input = {
      specialHourPeriods: [
        {
          startDate: { year: 2026, month: 12, day: 25 },
          closed: true,
          summary: "Christmas Day",
        },
      ],
    };
    const { rows, errors } = parseSpecialHours(input);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isClosed).toBe(true);
    expect(rows[0]!.label).toBe("Christmas Day");
    expect(rows[0]!.date.toISOString().slice(0, 10)).toBe("2026-12-25");
  });

  it("parses reduced-hours entries", () => {
    const input = {
      specialHourPeriods: [
        {
          startDate: { year: 2026, month: 12, day: 24 },
          openTime: { hours: 9 },
          closeTime: { hours: 14 },
        },
      ],
    };
    const { rows } = parseSpecialHours(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.openTime).toBe("09:00");
    expect(rows[0]!.closeTime).toBe("14:00");
    expect(rows[0]!.isClosed).toBe(false);
  });

  it("deduplicates entries on the same date", () => {
    const input = {
      specialHourPeriods: [
        { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
        { startDate: { year: 2026, month: 12, day: 25 }, closed: true },
      ],
    };
    const { rows } = parseSpecialHours(input);
    expect(rows).toHaveLength(1);
  });

  it("flags invalid dates without throwing", () => {
    const input = {
      specialHourPeriods: [
        { startDate: { year: 2026, month: 13, day: 1 }, closed: true },
        { startDate: "not a date object", closed: true },
      ],
    };
    const { rows, errors } = parseSpecialHours(input);
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.reason === "invalid_date")).toBe(true);
  });

  it("returns empty for missing input", () => {
    expect(parseSpecialHours(null)).toEqual({ rows: [], errors: [] });
    expect(parseSpecialHours({ specialHourPeriods: [] })).toEqual({ rows: [], errors: [] });
  });
});

describe("parseCategories", () => {
  it("extracts primary + secondary from profileJson shape", () => {
    const profile = {
      categories: {
        primaryCategory: { displayName: "Caterer", name: "categories/gcid:caterer" },
        additionalCategories: [
          { displayName: "Restaurant", name: "categories/gcid:restaurant" },
        ],
      },
    };
    const { rows, errors } = parseCategories(null, profile);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      categoryId: "gcid:caterer",
      displayName: "Caterer",
      isPrimary: true,
      order: 0,
    });
    expect(rows[1]).toMatchObject({
      categoryId: "gcid:restaurant",
      isPrimary: false,
      order: 1,
    });
  });

  it("falls back to an array-shaped categoriesJson", () => {
    const cats = [
      { displayName: "Plumber", name: "categories/gcid:plumber" },
      { displayName: "Emergency Plumber" },
    ];
    const { rows } = parseCategories(cats, null);
    expect(rows[0]!.isPrimary).toBe(true);
    expect(rows[0]!.displayName).toBe("Plumber");
    expect(rows[1]!.displayName).toBe("Emergency Plumber");
    expect(rows[1]!.categoryId).toBe("emergency_plumber");
  });

  it("returns no rows when nothing is parseable", () => {
    expect(parseCategories(null, null)).toEqual({ rows: [], errors: [] });
  });
});

describe("parseAttributes", () => {
  it("parses BOOL attributes from array shape", () => {
    const input = [{ attributeId: "has_website", valueType: "BOOL", values: [true] }];
    const { rows, errors } = parseAttributes(input);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueType).toBe("BOOL");
    expect(rows[0]!.boolValue).toBe(true);
    expect(rows[0]!.displayName).toBe("Website");
  });

  it("parses URL attributes from uriValues", () => {
    const input = [
      {
        attributeId: "url_menu",
        valueType: "URL",
        uriValues: [{ uri: "https://example.com/menu" }],
      },
    ];
    const { rows } = parseAttributes(input);
    expect(rows[0]!.urlValue).toBe("https://example.com/menu");
  });

  it("parses REPEATED_ENUM via repeatedEnumValue.setValues", () => {
    const input = [
      {
        attributeId: "service_types",
        valueType: "REPEATED_ENUM",
        repeatedEnumValue: { setValues: ["dine_in", "takeout"] },
      },
    ];
    const { rows } = parseAttributes(input);
    expect(rows[0]!.valueType).toBe("REPEATED_ENUM");
    expect(rows[0]!.enumValues).toEqual(["dine_in", "takeout"]);
  });

  it("strips categories/ prefix from attribute names", () => {
    const input = [
      { name: "categories/gcid:caterer/has_wifi", valueType: "BOOL", values: [false] },
    ];
    const { rows } = parseAttributes(input);
    expect(rows[0]!.attributeId).toBe("has_wifi");
    expect(rows[0]!.boolValue).toBe(false);
  });

  it("defaults to BOOL valueType when missing", () => {
    const input = [{ attributeId: "unknown_attr", values: [true] }];
    const { rows } = parseAttributes(input);
    expect(rows[0]!.valueType).toBe("BOOL");
    expect(rows[0]!.boolValue).toBe(true);
  });

  it("handles { attributes: [...] } wrapper shape", () => {
    const input = {
      attributes: [{ attributeId: "has_website", valueType: "BOOL", values: [true] }],
    };
    const { rows } = parseAttributes(input);
    expect(rows).toHaveLength(1);
  });

  it("flags fully unrecognized shape", () => {
    const { rows, errors } = parseAttributes("nonsense");
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toBe("not_a_recognized_shape");
  });

  it("returns empty for null/undefined input", () => {
    expect(parseAttributes(null)).toEqual({ rows: [], errors: [] });
    expect(parseAttributes(undefined)).toEqual({ rows: [], errors: [] });
  });
});
