import { describe, expect, it } from "bun:test";

import { sensitiveRateLimitDiscriminators } from "../middleware/sensitive-route-rate-limit";

describe("sensitive route rate-limit scope", () => {
  it("isolates authenticated users even when they share a server relay IP", () => {
    expect(
      sensitiveRateLimitDiscriminators({
        authUserId: "user-a",
        ip: "203.0.113.10",
      }),
    ).toEqual(["account:user-a"]);
    expect(
      sensitiveRateLimitDiscriminators({
        authUserId: "user-b",
        ip: "203.0.113.10",
      }),
    ).toEqual(["account:user-b"]);
  });

  it("keeps unauthenticated requests bound to their source IP", () => {
    expect(
      sensitiveRateLimitDiscriminators({ ip: "198.51.100.20" }),
    ).toEqual(["ip:198.51.100.20"]);
  });
});
