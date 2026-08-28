import { describe, expect, it } from "bun:test";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";

describe("Command pagination", () => {
  it("uses bounded defaults for invalid input", () => {
    expect(parseCommandPagination({ page: "0", pageSize: "nope" })).toEqual({
      page: 1,
      pageSize: 50,
      skip: 0,
    });
  });

  it("caps caller-controlled payload size", () => {
    expect(
      parseCommandPagination({ page: "3", pageSize: "50000" }),
    ).toEqual({ page: 3, pageSize: 100, skip: 200 });
  });

  it("lets an endpoint raise its own ceiling without moving the default", () => {
    // The overview does this so the whole roster fits in one request: that
    // endpoint recomputes the entire Command payload before slicing out a page,
    // so a caller who needs every account should not have to pay for the
    // aggregation once per hundred of them.
    expect(
      parseCommandPagination({ page: "1", pageSize: "250", maxPageSize: 500 }),
    ).toEqual({ page: 1, pageSize: 250, skip: 0 });
    // Raising the ceiling must not raise what an unasked-for request gets.
    expect(parseCommandPagination({ maxPageSize: 500 })).toEqual({
      page: 1,
      pageSize: 50,
      skip: 0,
    });
    // And the ceiling is still a ceiling.
    expect(
      parseCommandPagination({ pageSize: "50000", maxPageSize: 500 }),
    ).toEqual({ page: 1, pageSize: 500, skip: 0 });
  });

  it("reports one empty page instead of page zero", () => {
    expect(
      commandPaginationResult({ page: 1, pageSize: 50, total: 0 }),
    ).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
  });
});

describe("parseCommandPagination page ceiling", () => {
  it("clamps an absurd page so the offset stays bounded", () => {
    const { page, skip } = parseCommandPagination({
      page: "999999999",
      pageSize: "250",
      maxPageSize: 500,
    });
    expect(page).toBe(10_000);
    expect(skip).toBe(9_999 * 250);
    expect(Number.isSafeInteger(skip)).toBe(true);
  });

  it("leaves a realistic page alone", () => {
    expect(parseCommandPagination({ page: "3", pageSize: "50" })).toEqual({
      page: 3,
      pageSize: 50,
      skip: 100,
    });
  });

  it("still rejects a non-numeric or negative page", () => {
    expect(parseCommandPagination({ page: "-4" }).page).toBe(1);
    expect(parseCommandPagination({ page: "abc" }).page).toBe(1);
    expect(parseCommandPagination({ page: "0" }).page).toBe(1);
  });

  it("keeps skip an integer at the ceiling with the largest page size", () => {
    const { skip } = parseCommandPagination({
      page: String(Number.MAX_SAFE_INTEGER),
      pageSize: "500",
      maxPageSize: 500,
    });
    expect(Number.isSafeInteger(skip)).toBe(true);
    expect(skip).toBe(9_999 * 500);
  });
});
