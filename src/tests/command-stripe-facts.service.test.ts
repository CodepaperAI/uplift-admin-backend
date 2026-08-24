import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import {
  buildCommandInvoiceFact,
  buildCommandSubscriptionFact,
  canMergeStripeCommandAccount,
  normalizeCommandAccountEmail,
  shouldAdvanceCommandSubscriptionSnapshot,
} from "../services/command-stripe-facts.service";

describe("Command Stripe facts", () => {
  it("normalizes the account email used to join provider identities", () => {
    expect(normalizeCommandAccountEmail(" Customer@Example.com ")).toBe(
      "customer@example.com",
    );
    expect(normalizeCommandAccountEmail("invalid")).toBeNull();
  });

  it("keeps duplicate Stripe customer identities separate on email collision", () => {
    expect(canMergeStripeCommandAccount("cus_1", "cus_2")).toBe(false);
    expect(canMergeStripeCommandAccount(null, "cus_2")).toBe(true);
  });

  it("never lets an out-of-order webhook roll the current snapshot backward", () => {
    const current = new Date("2026-08-12T16:00:00.000Z");
    expect(
      shouldAdvanceCommandSubscriptionSnapshot(
        current,
        new Date("2026-08-12T15:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      shouldAdvanceCommandSubscriptionSnapshot(current, current),
    ).toBe(true);
    expect(
      shouldAdvanceCommandSubscriptionSnapshot(
        current,
        new Date("2026-08-12T16:00:00.001Z"),
      ),
    ).toBe(true);
  });

  it("projects settled invoice amounts as exact provider minor units", () => {
    const invoice = {
      id: "in_paid",
      customer: "cus_1",
      subscription: "sub_1",
      status: "paid",
      billing_reason: "subscription_cycle",
      collection_method: "charge_automatically",
      amount_due: 14900,
      amount_paid: 14900,
      amount_remaining: 0,
      currency: "cad",
      attempt_count: 1,
      created: 1_786_500_000,
      status_transitions: { paid_at: 1_786_500_030 },
      hosted_invoice_url: "https://invoice.example/in_paid",
      invoice_pdf: "https://invoice.example/in_paid.pdf",
      lines: {
        data: [{ period: { start: 1_786_500_000, end: 1_789_178_400 } }],
      },
    } as unknown as Stripe.Invoice;

    const fact = buildCommandInvoiceFact({
      eventId: "evt_paid",
      invoice,
      userId: "user_1",
      businessId: "business_1",
    });

    expect(fact.amountPaidMinor.toString()).toBe("14900");
    expect(fact.amountRemainingMinor.toString()).toBe("0");
    expect(fact.currency).toBe("cad");
    expect(fact.stripeSubscriptionId).toBe("sub_1");
    expect(fact.paidAt?.toISOString()).toBe("2026-08-12T02:00:30.000Z");
  });

  it("captures paused subscription state using the provider event id", () => {
    const subscription = {
      id: "sub_paused",
      customer: "cus_1",
      status: "active",
      pause_collection: { behavior: "void" },
      cancel_at_period_end: false,
      metadata: { userId: "user_1" },
      items: {
        data: [
          {
            quantity: 2,
            price: {
              id: "price_yearly",
              currency: "cad",
              unit_amount: 12000,
              unit_amount_decimal: "12000",
              recurring: { interval: "year", interval_count: 1 },
            },
            current_period_start: 1_786_500_000,
            current_period_end: 1_789_178_400,
          },
        ],
      },
    } as unknown as Stripe.Subscription;
    const event = {
      id: "evt_subscription_updated",
      type: "customer.subscription.updated",
      created: 1_786_500_030,
    } as Stripe.Event;

    const fact = buildCommandSubscriptionFact({ event, subscription });

    expect(fact.stripeEventId).toBe("evt_subscription_updated");
    expect(fact.pauseCollectionBehavior).toBe("void");
    expect(fact.status).toBe("active");
    expect(fact.stripePriceIds).toEqual(["price_yearly"]);
    expect(fact.monthlyRecurringMinor.toString()).toBe("2000");
    expect(fact.currency).toBe("cad");
  });
});
