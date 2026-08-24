import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  resolveSecondaryOnboardingScanTransition,
  serializeOnboardingV2State,
} from "../controllers/quick-scrape.controller";

describe("secondary onboarding-v2 contract", () => {
  test("advances an autosaved Step-1 draft after a successful website scan", () => {
    expect(
      resolveSecondaryOnboardingScanTransition({
        onboardingV2Step: "website",
      }),
    ).toEqual({ nextStep: "services", resumed: false });
  });

  test("deduplicates a submitted website against its guarded document identity", () => {
    const controller = readFileSync(
      resolve(import.meta.dir, "../controllers/quick-scrape.controller.ts"),
      "utf8",
    );
    const begin = controller.slice(
      controller.indexOf("export async function beginSecondaryOnboardingV2"),
      controller.indexOf("async function findOwnedOnboardingV2State"),
    );

    expect(begin).toContain("resolveOnboardingWebsiteIdentityUrl(normalizedUrl)");
    expect(begin).toContain("...getEquivalentWebsiteUrls(normalizedUrl)");
    expect(begin).toContain("...getEquivalentWebsiteUrls(canonicalWebsiteUrl)");
    expect(begin).toContain("quickScrapeServices(canonicalWebsiteUrl)");
    expect(begin).toContain("businessWebsiteUrl: canonicalWebsiteUrl");
  });

  test("preserves genuine progress when resuming beyond the website step", () => {
    expect(
      resolveSecondaryOnboardingScanTransition({
        onboardingV2Step: "questions",
      }),
    ).toEqual({ nextStep: "questions", resumed: true });
  });

  test("serializes explicit secondary payment state without changing the historical QSB businessId", () => {
    const state = serializeOnboardingV2State(
      {
        id: "quick-1",
        onboardingV2Flow: "website_secondary",
        onboardingV2BusinessId: "business-2",
        onboardingV2Step: "preview",
        onboardingV2Status: "in_progress",
        onboardingV2Answers: {},
        onboardingV2AnswerRevision: 2,
        onboardingV2QuestionIndex: 4,
        onboardingV2BlogStatus: "complete",
        onboardingV2SocialStatus: "complete",
        onboardingV2GenerationError: null,
        onboardingV2Author: null,
        detectedServices: [],
        selectedServices: [],
        servicesPriority: {},
        serviceAreaLocations: [],
        businessWebsiteUrl: "https://example.com/",
      },
      { paymentStatus: "active" },
    );

    expect(state.businessId).toBe("quick-1");
    expect(state.provisionalBusinessId).toBe("business-2");
    expect(state.flow).toBe("website_secondary");
    expect(state.paymentStatus).toBe("active");
    expect(state.paymentRequired).toBe(false);
  });

  test("serializes legacy oversized services into the current onboarding contract", () => {
    const oversized = `Buyer representation ${"with detailed guidance ".repeat(20)}`;
    const state = serializeOnboardingV2State({
      id: "quick-legacy",
      onboardingV2Answers: {},
      detectedServices: [oversized],
      selectedServices: [oversized],
      servicesPriority: {},
      serviceAreaLocations: [],
    });

    expect(state.detectedServices[0]!.length).toBeLessThanOrEqual(200);
    expect(state.selectedServices[0]!.length).toBeLessThanOrEqual(200);
  });

  test("requires checkout only when the exact secondary website subscription is not active", () => {
    const base = {
      id: "quick-1",
      onboardingV2Flow: "website_secondary",
      onboardingV2BusinessId: "business-2",
      onboardingV2Answers: {},
      detectedServices: [],
      selectedServices: [],
      servicesPriority: {},
      serviceAreaLocations: [],
    };
    expect(
      serializeOnboardingV2State(base, { paymentStatus: "trialing" })
        .paymentRequired,
    ).toBe(false);
    expect(
      serializeOnboardingV2State(base, { paymentStatus: "past_due" })
        .paymentRequired,
    ).toBe(true);

    const controller = readFileSync(
      resolve(import.meta.dir, "../controllers/quick-scrape.controller.ts"),
      "utf8",
    );
    expect(controller).toContain(
      "const paymentStatus = await getOnboardingV2PaymentStatus(\n      result.quickBusiness",
    );
  });

  test("keeps completion and initialization on dedicated events and registers both workers", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    expect(source).toContain(
      'event: "website-secondary/onboarding-v2.initialize"',
    );
    expect(source).toContain(
      'event: "website-secondary/onboarding-v2.complete"',
    );
    expect(source).toContain("secondaryOnboardingV2InitializeTask,");
    expect(source).toContain("secondaryOnboardingV2CompleteTask,");
    expect(source).toContain('step.invoke("generate-secondary-keywords"');
    expect(source).toContain('id: `secondary-onboarding-v2-social-topics:');

    const completeTask = source.slice(
      source.indexOf("export const secondaryOnboardingV2CompleteTask"),
      source.indexOf("export const websiteOnboardTask"),
    );
    expect(completeTask).toContain("if (!contract.skipped) {");
    expect(completeTask).not.toContain(
      "if (contract.skipped) {\n      return { success: true",
    );
    expect(completeTask).toContain('function: generateKeywordsTask');
    expect(completeTask).toContain('onboardingStatus: "running"');
    expect(completeTask).toContain('"complete-secondary-onboarding"');
    expect(completeTask).toContain("lockPrimaryWorkspaceSelection(tx, userId)");
    expect(completeTask).toContain("where: { userId, isPrimary: true }");
    expect(completeTask).toContain("isPrimary: true");
    expect(completeTask.indexOf('function: generateKeywordsTask')).toBeLessThan(
      completeTask.indexOf('onboardingStatus: "completed"'),
    );
    const completionContract = completeTask.slice(
      completeTask.indexOf('step.run("validate-secondary-completion-contract"'),
      completeTask.indexOf("try {"),
    );
    expect(completionContract).not.toContain("isPrimary: false");

    const controller = readFileSync(
      resolve(import.meta.dir, "../controllers/quick-scrape.controller.ts"),
      "utf8",
    );
    const completionClaim = controller.slice(
      controller.indexOf("export async function completeSecondaryOnboardingV2"),
      controller.indexOf("export async function patchOnboardingV2State"),
    );
    const completionBusinessLookup = completionClaim.slice(
      completionClaim.indexOf("const business = await tx.business.findFirst"),
      completionClaim.indexOf("if (!business)"),
    );
    expect(completionBusinessLookup).not.toContain("isPrimary: false");
  });

  test("website listing exposes only a bounded resume descriptor and switching is entitlement-gated", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../controllers/website.controller.ts"),
      "utf8",
    );
    expect(source).toContain("onboardingV2: secondarySession");
    expect(source).toContain("quickBusinessId: secondarySession.id");
    expect(source).toContain("resolveWebsiteWorkspaceAccess");
    expect(source).toContain("!access.canAccessWorkspace");
    expect(source).toContain("!access.canSelectWorkspace");
    expect(source).toContain('["active", "trialing"].includes');
  });

  test("keeps onboarding-v2 APIs and secondary initialization canonical without a rollout flag", () => {
    const quickScrapeController = readFileSync(
      resolve(import.meta.dir, "../controllers/quick-scrape.controller.ts"),
      "utf8",
    );
    const websiteController = readFileSync(
      resolve(import.meta.dir, "../controllers/website.controller.ts"),
      "utf8",
    );

    expect(quickScrapeController).not.toContain(
      "ONBOARDING_V2_FUNCTIONAL_ENABLED",
    );
    expect(websiteController).not.toContain(
      "ONBOARDING_V2_FUNCTIONAL_ENABLED",
    );
    expect(websiteController).toContain(
      'business.onboardingFlow === "website_secondary"',
    );
  });
});
