import { afterEach, describe, expect, it } from "bun:test";
import {
  assertGmbDemoModeEnabled,
  isGmbDemoModeEnabled,
} from "../services/gmb-demo-data.service";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_DEPLOY_ENV = process.env.DEPLOY_ENV;
const ORIGINAL_ENVIRONMENT = process.env.ENVIRONMENT;
const ORIGINAL_GMB_DEMO_MODE = process.env.GMB_DEMO_MODE;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  restoreEnvValue("APP_ENV", ORIGINAL_APP_ENV);
  restoreEnvValue("DEPLOY_ENV", ORIGINAL_DEPLOY_ENV);
  restoreEnvValue("ENVIRONMENT", ORIGINAL_ENVIRONMENT);
  restoreEnvValue("GMB_DEMO_MODE", ORIGINAL_GMB_DEMO_MODE);
});

describe("GMB demo mode guard", () => {
  it("is disabled in production even when the flag is set", () => {
    process.env.NODE_ENV = "production";
    process.env.GMB_DEMO_MODE = "true";

    expect(isGmbDemoModeEnabled()).toBe(false);
    expect(() => assertGmbDemoModeEnabled()).toThrow(
      "GMB demo mode is not enabled",
    );
  });

  it("is enabled only for non-production with GMB_DEMO_MODE=true", () => {
    process.env.NODE_ENV = "development";
    process.env.GMB_DEMO_MODE = "true";

    expect(isGmbDemoModeEnabled()).toBe(true);
    expect(() => assertGmbDemoModeEnabled()).not.toThrow();
  });

  it("is enabled for the dev deployment even when Docker uses NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ENV = "development";
    process.env.GMB_DEMO_MODE = "true";

    expect(isGmbDemoModeEnabled()).toBe(true);
    expect(() => assertGmbDemoModeEnabled()).not.toThrow();
  });
});

function restoreEnvValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
