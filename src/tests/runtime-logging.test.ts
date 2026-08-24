import { describe, expect, it } from "bun:test";
import {
  configureRuntimeLogging,
  isVerboseBackendLoggingEnabled,
} from "../config/runtime-logging";

describe("runtime logging", () => {
  it("disables informational logs by default", () => {
    let calls = 0;
    const target = { log: (..._args: unknown[]) => { calls += 1; } };

    configureRuntimeLogging(target, {
      NODE_ENV: "production",
      BACKEND_VERBOSE_LOGGING: undefined,
    });
    target.log("suppressed");

    expect(calls).toBe(0);
  });

  it("allows an explicit temporary verbose mode", () => {
    let calls = 0;
    const target = { log: (..._args: unknown[]) => { calls += 1; } };

    configureRuntimeLogging(target, {
      NODE_ENV: "production",
      BACKEND_VERBOSE_LOGGING: "true",
    });
    target.log("visible");

    expect(calls).toBe(1);
  });

  it("does not hide logs from the test runner", () => {
    expect(
      isVerboseBackendLoggingEnabled({
        NODE_ENV: "test",
        BACKEND_VERBOSE_LOGGING: undefined,
      }),
    ).toBe(true);
  });
});
