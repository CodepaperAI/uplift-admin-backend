type StripeMetadata = Record<string, string> | null | undefined;

export type StripeSessionBinding = {
  userId: string;
  type: string | null;
  businessId: string | null;
  quickScrapeBusinessId: string | null;
  onboardingMode: string | null;
};

function clean(metadata: StripeMetadata, key: string): string | null {
  const value = metadata?.[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

function agree(
  checkoutMetadata: StripeMetadata,
  subscriptionMetadata: StripeMetadata,
  key: string,
): { valid: boolean; value: string | null } {
  const checkoutValue = clean(checkoutMetadata, key);
  const subscriptionValue = clean(subscriptionMetadata, key);
  if (
    checkoutValue &&
    subscriptionValue &&
    checkoutValue !== subscriptionValue
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value: checkoutValue ?? subscriptionValue };
}

/**
 * Treat Stripe metadata as a signed ownership envelope. Client request fields
 * are intentionally excluded: knowing a Checkout Session ID must not let a
 * caller attach that payment to a different tenant or onboarding workspace.
 */
export function resolveStripeSessionBinding(
  checkoutMetadata: StripeMetadata,
  subscriptionMetadata: StripeMetadata,
): StripeSessionBinding | null {
  const user = agree(checkoutMetadata, subscriptionMetadata, "userId");
  const type = agree(checkoutMetadata, subscriptionMetadata, "type");
  const business = agree(checkoutMetadata, subscriptionMetadata, "businessId");
  const quickBusiness = agree(
    checkoutMetadata,
    subscriptionMetadata,
    "quickScrapeBusinessId",
  );
  const onboarding = agree(
    checkoutMetadata,
    subscriptionMetadata,
    "onboardingMode",
  );

  if (
    !user.valid ||
    !type.valid ||
    !business.valid ||
    !quickBusiness.valid ||
    !onboarding.valid ||
    !user.value
  ) {
    return null;
  }

  return {
    userId: user.value,
    type: type.value,
    businessId: business.value,
    quickScrapeBusinessId: quickBusiness.value,
    onboardingMode: onboarding.value,
  };
}

export function isStripeCheckoutSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^cs_(?:test_|live_)?[A-Za-z0-9]{16,220}$/.test(value)
  );
}
