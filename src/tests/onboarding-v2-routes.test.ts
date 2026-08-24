import { describe, expect, it } from "bun:test";

import QuickScrapeRouter from "../services/quick-scrape.service";

describe("onboarding-v2 route security wiring", () => {
  it("registers every state/generation route behind backend auth", () => {
    const routes = (QuickScrapeRouter as any).stack
      .filter((layer: any) => String(layer.route?.path ?? "").startsWith("/onboarding-v2"))
      .map((layer: any) => ({
        path: layer.route.path,
        method: Object.keys(layer.route.methods)[0],
        handlers: layer.route.stack.map((entry: any) => entry.handle.name),
      }));

    expect(routes).toEqual([
      {
        path: "/onboarding-v2/state",
        method: "get",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "getOnboardingV2State",
        ],
      },
      {
        path: "/onboarding-v2/secondary/begin",
        method: "post",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "beginSecondaryOnboardingV2",
        ],
      },
      {
        path: "/onboarding-v2/secondary/sessions",
        method: "get",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "listSecondaryOnboardingV2Sessions",
        ],
      },
      {
        path: "/onboarding-v2/complete-secondary",
        method: "post",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "completeSecondaryOnboardingV2",
        ],
      },
      {
        path: "/onboarding-v2/state",
        method: "patch",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "patchOnboardingV2State",
        ],
      },
      {
        path: "/onboarding-v2/author-image",
        method: "post",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "onboardingV2AuthorImageUpload",
          "uploadOnboardingV2AuthorImageController",
        ],
      },
      {
        path: "/onboarding-v2/brand-logo",
        method: "post",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "onboardingV2BrandLogoUpload",
          "uploadOnboardingV2BrandLogoController",
        ],
      },
      {
        path: "/onboarding-v2/start-generation",
        method: "post",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "startOnboardingV2Generation",
        ],
      },
      {
        path: "/onboarding-v2/preview",
        method: "get",
        handlers: [
          "correlationIdMiddleware",
          "requireBackendAuth",
          "getOnboardingV2Preview",
        ],
      },
    ]);
  });
});
