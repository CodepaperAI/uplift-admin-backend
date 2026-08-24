import Stripe from "stripe";

/**
 * Shared server-only Stripe client. Routes must fail closed when the secret is
 * unavailable; the client is never exported to browser bundles.
 */
const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";

export const isStripeConfigured = stripeSecretKey.length > 0;

export const stripe: Stripe = isStripeConfigured
  ? new Stripe(stripeSecretKey, {
      apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
    })
  : (null as unknown as Stripe);
