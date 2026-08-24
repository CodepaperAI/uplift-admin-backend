import { describe, expect, it } from "bun:test";
import { redisUrlRequiresTls } from "../utils/tenant-response-cache";

describe("Redis transport policy", () => {
  it("requires TLS for remote production Redis", () => {
    expect(
      redisUrlRequiresTls({
        hostname: "redis.example.com",
        passwordPresent: true,
        nodeEnv: "production",
        appEnv: "production",
      }),
    ).toBe(true);
  });

  it("allows authenticated Redis on the isolated development Docker network", () => {
    expect(
      redisUrlRequiresTls({
        hostname: "redis",
        passwordPresent: true,
        nodeEnv: "production",
        appEnv: "development",
      }),
    ).toBe(false);
  });

  it("does not allow an unauthenticated development Docker Redis exception", () => {
    expect(
      redisUrlRequiresTls({
        hostname: "redis",
        passwordPresent: false,
        nodeEnv: "production",
        deployEnv: "development",
      }),
    ).toBe(true);
  });

  it("keeps the Docker hostname TLS requirement in production deployments", () => {
    expect(
      redisUrlRequiresTls({
        hostname: "redis",
        passwordPresent: true,
        nodeEnv: "production",
        appEnv: "production",
      }),
    ).toBe(true);
  });
});
