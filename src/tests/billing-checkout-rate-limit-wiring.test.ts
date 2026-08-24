import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

describe("billing checkout rate-limit wiring", () => {
  it("keeps checkout creation strict while isolating idempotent verification", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../routes/billing-portal.routes.ts"),
      "utf8",
    );

    expect(source).toContain('namespace: "billing-primary-checkout"');
    expect(source).toContain('namespace: "billing-checkout-verification"');
    expect(source).toMatch(
      /"\/checkout\/add-website",\s*checkoutLimit,\s*createAddWebsiteCheckoutSession/,
    );
    expect(source).toMatch(
      /"\/checkout\/verify-session",\s*checkoutVerificationLimit,\s*verifyCheckoutSession/,
    );
    expect(source).toMatch(
      /"\/subscription\/cancel-scheduled-change",\s*planChangeLimit,\s*cancelScheduledSubscriptionPlanChange/,
    );
  });
});
