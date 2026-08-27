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
