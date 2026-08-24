import { describe, expect, test } from "bun:test";

import {
  isBrandAnalysisPending,
  MANUAL_BRAND_ANALYSIS_PENDING_VERSION,
  ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION,
} from "../utils/brand-analysis-status.utils";

describe("brand analysis status", () => {
  test("keeps both onboarding and manual refreshes in processing state", () => {
    expect(isBrandAnalysisPending(ONBOARDING_BRAND_ANALYSIS_PENDING_VERSION)).toBe(
      true,
    );
    expect(isBrandAnalysisPending(MANUAL_BRAND_ANALYSIS_PENDING_VERSION)).toBe(
      true,
    );
  });

  test("treats completed and failed versions as terminal", () => {
    expect(isBrandAnalysisPending("context-dev-brand-v1")).toBe(false);
    expect(isBrandAnalysisPending("3.0")).toBe(false);
    expect(isBrandAnalysisPending("3.0-error")).toBe(false);
    expect(isBrandAnalysisPending(null)).toBe(false);
  });
});
