type StripeCustomerDiscountClient = {
  retrieve: (customerId: string) => Promise<{
    deleted?: boolean | void;
    discount?: unknown;
  }>;
  deleteDiscount: (customerId: string) => Promise<unknown>;
};

/**
 * Removes only the customer-level default discount. Subscription/item-level
 * discounts on existing subscriptions are handled by the plan-change route.
 */
export async function clearExistingCustomerDiscount(
  customerId: string,
  customers: StripeCustomerDiscountClient,
): Promise<boolean> {
  const customer = await customers.retrieve(customerId);

  if (customer.deleted === true) {
    throw new Error("Stripe customer is no longer available");
  }

  if (!customer.discount) {
    return false;
  }

  await customers.deleteDiscount(customerId);
  return true;
}
