import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("brand analysis onboarding wiring", () => {
  test("forces the working brand-analysis worker from complete onboarding", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    const completeOnboardingTask = source.slice(
      source.indexOf("export const completeOnboardingTask"),
      source.indexOf("export const secondaryOnboardingV2InitializeTask"),
    );

    expect(completeOnboardingTask).toContain(
      'step.sendEvent("trigger-brand-analysis"',
    );
    expect(completeOnboardingTask).toContain('name: "brand/analyze"');
    expect(completeOnboardingTask).toContain("forceRefresh: true");
    expect(completeOnboardingTask).toContain(
      'source: "complete_onboarding"',
    );
    expect(completeOnboardingTask).toContain(
      'step.sendEvent("refresh-idempotent-brand-analysis"',
    );
    expect(completeOnboardingTask).toContain(
      'source: "complete_onboarding_idempotent"',
    );
  });

  test("refreshes an existing partial analysis by upserting the full result", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    const brandTask = source.slice(
      source.indexOf("export const brandAnalysisTask"),
      source.indexOf("export const scheduledBlogDistributionScannerTask"),
    );

    expect(brandTask).toContain(
      "const forceRefresh = event.data.forceRefresh === true",
    );
    expect(brandTask).toContain('key: "event.data.businessId"');
    expect(brandTask).toContain('mode: "skip"');
    expect(brandTask).toContain("INNGEST_BRAND_ANALYSIS_CONCURRENCY");
    expect(brandTask).toContain("existingAnalysis && !forceRefresh");
    expect(brandTask).toContain("preserveApprovedIdentity");
    expect(brandTask).toContain("const currentAnalysis");
    expect(brandTask).toContain("canonicalizeRemoteBusinessBrandLogo");
    expect(brandTask).toContain("prisma.brandAnalysis.upsert");
    expect(brandTask).toContain("update: analysisFields");
    expect(brandTask).toContain('where: { businessId, source: "scraped" }');
  });

  test("marks all onboarding and manual requests as explicit refreshes", () => {
    const persistenceSource = readFileSync(
      resolve(import.meta.dir, "../services/onboarding-persistence.service.ts"),
      "utf8",
    );
    const controllerSource = readFileSync(
      resolve(import.meta.dir, "../controllers/business.controller.ts"),
      "utf8",
    );

    expect(persistenceSource).toContain('source: "onboarding_persistence"');
    expect(controllerSource).toContain('source: "create_business"');
    expect(controllerSource).toContain('source: "manual_reanalysis"');
    expect(controllerSource).toContain("isBrandAnalysisPending");
    expect(controllerSource).toContain(
      "MANUAL_BRAND_ANALYSIS_PENDING_VERSION",
    );
  });
});
