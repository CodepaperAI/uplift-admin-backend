import { describe, expect, it } from "bun:test";

import { resolveOnboardingV2PersistedStep } from "../utils/onboarding-v2-state.utils";
import { PATCH_ONBOARDING_V2_STATE } from "../validators/quick-scrape.validation";

describe("onboarding v2 persisted state", () => {
  it("cannot regress the checkout step while payment is pending", () => {
    expect(
      resolveOnboardingV2PersistedStep({
        currentStep: "payment",
        currentStatus: "awaiting_payment",
        requestedStep: "preview",
      }),
    ).toBe("payment");
  });

  it("accepts the canonical confirmed brand contract", () => {
    const result = PATCH_ONBOARDING_V2_STATE.parse({
      businessId: "50897899-e853-42a7-96cf-f79f55ec8efb",
      step: "brand",
      brand: {
        primaryColors: ["#123456"],
        secondaryColors: ["#abcdef"],
        fontFamily: "Inter",
        logoUrl: "https://cdn.example.com/logo.png",
        logoAltText: "Example logo",
        faviconUrl: "",
        referenceImageUrl: "https://cdn.example.com/reference.jpg",
        slogan: "Built carefully",
      },
    });
    expect(result.step).toBe("brand");
    expect(result.brand?.logoUrl).toBe("https://cdn.example.com/logo.png");
  });

  it("rejects non-HTTP brand assets", () => {
    expect(() =>
      PATCH_ONBOARDING_V2_STATE.parse({
        businessId: "50897899-e853-42a7-96cf-f79f55ec8efb",
        brand: {
          primaryColors: [],
          secondaryColors: [],
          fontFamily: "",
          logoUrl: "file:///etc/passwd",
          logoAltText: "",
          faviconUrl: "",
          referenceImageUrl: "",
          slogan: "",
        },
      }),
    ).toThrow();
  });
});
