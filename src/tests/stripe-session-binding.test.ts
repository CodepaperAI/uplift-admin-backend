import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isStripeCheckoutSessionId,
  resolveStripeSessionBinding,
} from "../utils/stripe-session-binding";

describe("Stripe session ownership binding", () => {
  it("requires a Stripe-bound user and matching ownership metadata", () => {
    expect(resolveStripeSessionBinding({}, {})).toBeNull();
    expect(
      resolveStripeSessionBinding(
        {
          userId: "user-1",
          type: "add_website",
          businessId: "business-1",
        },
        { userId: "user-1", businessId: "business-1" },
      ),
    ).toEqual({
      userId: "user-1",
      type: "add_website",
      businessId: "business-1",
      quickScrapeBusinessId: null,
      onboardingMode: null,
    });
    expect(
      resolveStripeSessionBinding(
        { userId: "user-1", businessId: "business-1" },
        { userId: "user-2", businessId: "business-1" },
      ),
    ).toBeNull();
  });

  it("strictly validates checkout-session identifiers", () => {
    expect(isStripeCheckoutSessionId("cs_test_1234567890abcdefghijkl")).toBe(
      true,
    );
    expect(isStripeCheckoutSessionId("not-a-session")).toBe(false);
    expect(isStripeCheckoutSessionId("cs_test_" + "a".repeat(221))).toBe(
      false,
    );
  });

  it("checks ownership before paid-intro provider mutations", () => {
    const route = readFileSync(
      resolve(
        process.cwd(),
        "src/controllers/billing-verification.controller.ts",
      ),
      "utf8",
    );
    const ownershipCheck = route.indexOf("const initialBinding");
    const provisioning = route.indexOf(
      "ensureOnboardingV2PaidIntroSubscription(stripe, checkoutSession)",
    );
    const schedule = route.indexOf(
      "ensureOnboardingV2PaidIntroSchedule(stripe, stripeSubscription)",
    );
    expect(ownershipCheck).toBeGreaterThan(-1);
    expect(ownershipCheck).toBeLessThan(provisioning);
    expect(ownershipCheck).toBeLessThan(schedule);
  });

  it("rejects zero-dollar paid intros and gives retries a fresh Checkout idempotency version", () => {
    const checkout = readFileSync(
      resolve(process.cwd(), "src/controllers/billing-checkout.controller.ts"),
      "utf8",
    );
    const verification = readFileSync(
      resolve(process.cwd(), "src/controllers/billing-verification.controller.ts"),
      "utf8",
    );
    const webhook = readFileSync(
      resolve(process.cwd(), "src/controllers/stripe-webhook.controller.ts"),
      "utf8",
    );

    expect(checkout).toContain("allow_promotion_codes: !onboardingTrial");
    expect(checkout).toContain("onboarding-v2-paid-intro-v3:");
    expect(verification).toContain("PAID_INTRO_PAYMENT_METHOD_REQUIRED");
    expect(verification).toContain("checkoutSession.amount_total === 0");
    expect(webhook).toContain("session.amount_total === 0");
    expect(webhook).toContain("provisioning was skipped");
  });
});
