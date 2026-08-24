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

  it("reports one empty page instead of page zero", () => {
    expect(
      commandPaginationResult({ page: 1, pageSize: 50, total: 0 }),
    ).toEqual({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
  });
});
