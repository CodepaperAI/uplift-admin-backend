import type { Response } from "express";
import Stripe from "stripe";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
    })
  : null;

type BillingAddressInput = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

type CreateAdminSubscriptionBody = {
  businessId?: string;
  priceId?: string;
  billingPeriod?: string;
  collectionMethod?: "charge_automatically" | "send_invoice";
  daysUntilDue?: number | string;
  startDate?: string;
  trialEndDate?: string;
  couponId?: string;
  billingAddress?: BillingAddressInput;
};

type CreateAdminInvoiceBody = {
  businessId?: string;
  currency?: string;
  daysUntilDue?: number | string;
  memo?: string;
  sendNow?: boolean;
  billingAddress?: BillingAddressInput;
  lineItems?: Array<{
    description?: string;
    amountUsd?: number | string;
    amountCents?: number | string;
    quantity?: number | string;
  }>;
};

type SubscriptionActionBody = {
  cancelAtPeriodEnd?: boolean;
  priceId?: string;
};

type StripeSubscriptionPeriod = Stripe.Subscription & {
  current_period_start?: number | null;
  current_period_end?: number | null;
};

function requireStripe(res: Response): Stripe | null {
  if (!stripe) {
    sendError(res, "Stripe is not configured", 503);
    return null;
  }

  return stripe;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAmountCents(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed);
}

function parseAmountUsdToCents(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed * 100);
}

function parseDateToUnix(value: unknown): number | undefined {
  const raw = cleanString(value);
  if (!raw) {
    return undefined;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T12:00:00.000Z`
    : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return Math.floor(parsed.getTime() / 1000);
}

function unixToIso(value: number | null | undefined): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function dateFromUnix(value: number | null | undefined): Date | undefined {
  return typeof value === "number" ? new Date(value * 1000) : undefined;
}

function normalizeCountry(value: unknown): string {
  const country = cleanString(value).toUpperCase();
  if (country === "CANADA") return "CA";
  if (country === "UNITED STATES" || country === "USA" || country === "US") {
    return "US";
  }
  return country;
}

function buildStripeAddress(
  business: {
    businessAddress?: string | null;
    businessCity?: string | null;
    businessState?: string | null;
    businessCountry?: string | null;
  },
  input?: BillingAddressInput,
): Stripe.AddressParam {
  const country = normalizeCountry(input?.country) || normalizeCountry(business.businessCountry) || "CA";

  return {
    line1: cleanString(input?.line1) || cleanString(business.businessAddress),
    line2: cleanString(input?.line2) || undefined,
    city: cleanString(input?.city) || cleanString(business.businessCity) || undefined,
    state: cleanString(input?.state) || cleanString(business.businessState) || undefined,
    postal_code: cleanString(input?.postalCode) || undefined,
    country,
  };
}

function validateTaxAddress(address: Stripe.AddressParam): string | null {
  if (!address.line1) return "Billing street address is required for tax calculation";
  if (!address.city) return "Billing city is required for tax calculation";
  if (!address.country) return "Billing country is required for tax calculation";
  if (address.country === "CA" && !address.state) {
    return "Canadian province/territory is required for tax calculation";
  }
  if (address.country === "CA" && !address.postal_code) {
    return "Canadian postal code is required for tax calculation";
  }
  return null;
}

function serializeInvoice(invoice: Stripe.Invoice) {
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    status: invoice.status ?? null,
    customerId:
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer?.id ?? null,
    subscriptionId:
      typeof (invoice as Stripe.Invoice & { subscription?: unknown }).subscription ===
      "string"
        ? ((invoice as Stripe.Invoice & { subscription?: string }).subscription ?? null)
        : null,
    currency: invoice.currency ?? "usd",
    subtotalCents: invoice.subtotal ?? 0,
    taxAmountCents: (invoice.total_taxes ?? []).reduce(
      (sum, entry) => sum + (entry.amount ?? 0),
      0,
    ),
    totalCents: invoice.total ?? 0,
    amountPaidCents: invoice.amount_paid ?? 0,
    amountDueCents: invoice.amount_due ?? 0,
    createdAt: unixToIso(invoice.created),
    dueDate: unixToIso(invoice.due_date),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
  };
}

function invoiceMatchesSearch(invoice: Stripe.Invoice, query: string): boolean {
  if (!query) return true;

  const subscriptionId =
    typeof (invoice as Stripe.Invoice & { subscription?: unknown }).subscription ===
    "string"
      ? ((invoice as Stripe.Invoice & { subscription?: string }).subscription ?? "")
      : "";
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id ?? "";

  return [
    invoice.id,
    invoice.number,
    invoice.status,
    invoice.currency,
    customerId,
    subscriptionId,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function serializeSubscription(subscription: Stripe.Subscription) {
  const period = subscription as StripeSubscriptionPeriod;
  const firstItem = subscription.items.data[0];

  return {
    id: subscription.id,
    status: subscription.status,
    customerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id,
    stripeSubscriptionItemId: firstItem?.id ?? null,
    stripePriceId: firstItem?.price?.id ?? null,
    currentPeriodStart: unixToIso(period.current_period_start),
    currentPeriodEnd: unixToIso(period.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    collectionMethod: subscription.collection_method,
  };
}

async function writeBillingAuditLog(params: {
  adminUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
}) {
  await prisma.adminAuditLog.create({
    data: {
      adminUserId: params.adminUserId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      details:
        params.details !== undefined
          ? JSON.parse(JSON.stringify(params.details))
          : undefined,
    },
  });
}

async function getBusinessForBilling(businessId: string) {
  return prisma.business.findUnique({
    where: { id: businessId },
    include: {
      websiteSubscription: true,
      User: {
        include: {
          Subscription: true,
        },
      },
    },
  });
}

async function getOrCreateStripeCustomer(params: {
  stripeClient: Stripe;
  business: Awaited<ReturnType<typeof getBusinessForBilling>> & {};
  billingAddress?: BillingAddressInput;
}) {
  const { business, stripeClient } = params;
  if (!business) {
    throw new Error("Business not found");
  }

  const address = buildStripeAddress(business, params.billingAddress);
  const addressError = validateTaxAddress(address);
  if (addressError) {
    throw new Error(addressError);
  }

  const existingCustomerId = business.User.Subscription?.stripeCustomerId ?? null;
  if (existingCustomerId) {
    const customer = await stripeClient.customers.update(existingCustomerId, {
      name: business.User.name ?? business.businessName,
      email: business.User.email,
      phone: business.User.phone ?? business.businessPhone ?? undefined,
      address,
      metadata: {
        userId: business.userId,
        businessId: business.id,
        businessName: business.businessName,
      },
    });

    return typeof customer.deleted === "boolean" && customer.deleted
      ? null
      : customer;
  }

  const customer = await stripeClient.customers.create({
    name: business.User.name ?? business.businessName,
    email: business.User.email,
    phone: business.User.phone ?? business.businessPhone ?? undefined,
    address,
    metadata: {
      userId: business.userId,
      businessId: business.id,
      businessName: business.businessName,
    },
  });

  await prisma.subscription.upsert({
    where: { userId: business.userId },
    create: {
      userId: business.userId,
      status: "inactive",
      startDate: new Date(),
      stripeCustomerId: customer.id,
    },
    update: {
      stripeCustomerId: customer.id,
    },
  });

  return customer;
}

async function syncWebsiteSubscriptionFromStripe(params: {
  business: Awaited<ReturnType<typeof getBusinessForBilling>> & {};
  subscription: Stripe.Subscription;
}) {
  const { business, subscription } = params;
  if (!business) {
    throw new Error("Business not found");
  }

  const period = subscription as StripeSubscriptionPeriod;
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price?.id ?? null;

  await prisma.websiteSubscription.upsert({
    where: { businessId: business.id },
    create: {
      businessId: business.id,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionItemId: firstItem?.id ?? null,
      stripePriceId: priceId,
      status: subscription.status,
      currentPeriodStart: dateFromUnix(period.current_period_start),
      currentPeriodEnd: dateFromUnix(period.current_period_end),
      trialStartDate: dateFromUnix(subscription.trial_start),
      trialEndDate: dateFromUnix(subscription.trial_end),
      trialStatus: subscription.trial_end ? "trialing" : "none",
      agencyId: business.agencyId,
    },
    update: {
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionItemId: firstItem?.id ?? null,
      stripePriceId: priceId,
      status: subscription.status,
      currentPeriodStart: dateFromUnix(period.current_period_start),
      currentPeriodEnd: dateFromUnix(period.current_period_end),
      trialStartDate: dateFromUnix(subscription.trial_start),
      trialEndDate: dateFromUnix(subscription.trial_end),
      trialStatus:
        subscription.status === "trialing" || subscription.trial_end
          ? "trialing"
          : "converted",
      agencyId: business.agencyId,
    },
  });

  await prisma.business.update({
    where: { id: business.id },
    data: {
      websiteStatus:
        subscription.status === "active" || subscription.status === "trialing"
          ? "active"
          : business.websiteStatus,
      stripeSubscriptionItemId: firstItem?.id ?? business.stripeSubscriptionItemId,
    },
  });
}

async function listConfiguredPrices(stripeClient: Stripe) {
  const values = [
    ["Platform monthly", process.env.UPLIFT_PLAN_PRICE_ID],
    ["Platform yearly", process.env.UPLIFT_YEARLY_PRICE_ID],
    ["Website monthly", process.env.WEBSITE_PRICE_ID],
    ["Website yearly", process.env.WEBSITE_YEARLY_PRICE_ID],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  const unique = Array.from(new Map(values.map(([label, id]) => [id, label])));

  return Promise.all(
    unique.map(async ([id, label]) => {
      try {
        const price = await stripeClient.prices.retrieve(id);
        return {
          label,
          priceId: id,
          active: price.active,
          currency: price.currency,
          unitAmountCents: price.unit_amount ?? null,
          interval: price.recurring?.interval ?? null,
        };
      } catch {
        return {
          label,
          priceId: id,
          active: false,
          currency: null,
          unitAmountCents: null,
          interval: null,
        };
      }
    }),
  );
}

export async function getSuperadminBillingDashboard(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const search = cleanString(req.query.search).toLowerCase();
    const status = cleanString(req.query.status);
    const invoiceSearch = cleanString(req.query.invoiceSearch).toLowerCase();

    const businesses = await prisma.business.findMany({
      where: {
        ...(search
          ? {
              OR: [
                { businessName: { contains: search, mode: "insensitive" } },
                { businessWebsiteUrl: { contains: search, mode: "insensitive" } },
                { User: { email: { contains: search, mode: "insensitive" } } },
              ],
            }
          : {}),
        ...(status
          ? {
              websiteSubscription: {
                is: {
                  status,
                },
              },
            }
          : {}),
      },
      include: {
        websiteSubscription: true,
        User: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            Subscription: {
              select: {
                stripeCustomerId: true,
              },
            },
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 50,
    });

    const [prices, invoices] = await Promise.all([
      listConfiguredPrices(stripeClient),
      stripeClient.invoices.list({ limit: invoiceSearch ? 100 : 25 }),
    ]);
    const invoiceRows = invoices.data.filter((invoice) =>
      invoiceMatchesSearch(invoice, invoiceSearch),
    );

    sendSuccess(
      res,
      {
        configuredPrices: prices,
        businesses: businesses.map((business) => ({
          id: business.id,
          businessName: business.businessName,
          businessWebsiteUrl: business.businessWebsiteUrl,
          businessAddress: business.businessAddress,
          businessCity: business.businessCity,
          businessState: business.businessState,
          businessCountry: business.businessCountry,
          websiteStatus: business.websiteStatus,
          user: {
            id: business.User.id,
            email: business.User.email,
            name: business.User.name,
            phone: business.User.phone,
            stripeCustomerId: business.User.Subscription?.stripeCustomerId ?? null,
          },
          websiteSubscription: business.websiteSubscription
            ? {
                id: business.websiteSubscription.id,
                status: business.websiteSubscription.status,
                stripeSubscriptionId:
                  business.websiteSubscription.stripeSubscriptionId,
                stripeSubscriptionItemId:
                  business.websiteSubscription.stripeSubscriptionItemId,
                stripePriceId: business.websiteSubscription.stripePriceId,
                currentPeriodStart:
                  business.websiteSubscription.currentPeriodStart?.toISOString() ??
                  null,
                currentPeriodEnd:
                  business.websiteSubscription.currentPeriodEnd?.toISOString() ??
                  null,
                trialStatus: business.websiteSubscription.trialStatus,
                trialEndDate:
                  business.websiteSubscription.trialEndDate?.toISOString() ?? null,
              }
            : null,
        })),
        recentInvoices: invoiceRows.map(serializeInvoice),
      },
      "Billing dashboard retrieved",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to load billing dashboard", 500, error);
  }
}

export async function createSuperadminSubscription(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const body = req.body as CreateAdminSubscriptionBody;
    const businessId = cleanString(body.businessId);
    const priceId = cleanString(body.priceId);
    const collectionMethod = body.collectionMethod ?? "send_invoice";
    const daysUntilDue = parsePositiveInteger(body.daysUntilDue, 7);
    const couponId = cleanString(body.couponId);
    const now = Math.floor(Date.now() / 1000);
    const startAt = parseDateToUnix(body.startDate);
    const explicitTrialEnd = parseDateToUnix(body.trialEndDate);
    const trialEnd =
      explicitTrialEnd && explicitTrialEnd > now
        ? explicitTrialEnd
        : startAt && startAt > now
          ? startAt
          : undefined;

    if (!businessId) {
      sendError(res, "businessId is required", 400);
      return;
    }

    if (!priceId) {
      sendError(res, "priceId is required", 400);
      return;
    }

    const business = await getBusinessForBilling(businessId);
    if (!business) {
      sendError(res, "Business not found", 404);
      return;
    }

    const existing = business.websiteSubscription;
    if (
      existing?.stripeSubscriptionId &&
      ["active", "trialing", "past_due", "incomplete"].includes(existing.status)
    ) {
      sendError(res, "Business already has a live Stripe subscription", 409);
      return;
    }

    const customer = await getOrCreateStripeCustomer({
      stripeClient,
      business,
      billingAddress: body.billingAddress,
    });
    if (!customer) {
      sendError(res, "Stripe customer is deleted or unavailable", 409);
      return;
    }

    const metadata: Record<string, string> = {
      userId: business.userId,
      businessId: business.id,
      businessName: business.businessName,
      source: "superadmin",
      type: "admin_created",
      billingPeriod: cleanString(body.billingPeriod) || "custom",
    };
    if (business.agencyId) {
      metadata.agencyId = business.agencyId;
    }

    const subscription = await stripeClient.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      automatic_tax: { enabled: true },
      collection_method: collectionMethod,
      ...(collectionMethod === "send_invoice" ? { days_until_due: daysUntilDue } : {}),
      ...(trialEnd && trialEnd > Math.floor(Date.now() / 1000)
        ? { trial_end: trialEnd }
        : {}),
      ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
      metadata,
      payment_behavior:
        collectionMethod === "charge_automatically"
          ? "default_incomplete"
          : undefined,
      expand: ["latest_invoice"],
    });

    await syncWebsiteSubscriptionFromStripe({ business, subscription });

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.subscription.create",
      targetType: "StripeSubscription",
      targetId: subscription.id,
      details: {
        businessId,
        priceId,
        collectionMethod,
        daysUntilDue,
        startDate: cleanString(body.startDate) || null,
        trialEndDate: cleanString(body.trialEndDate) || null,
        automaticTax: true,
      },
    });

    sendSuccess(
      res,
      serializeSubscription(subscription),
      "Subscription created",
      201,
    );
  } catch (error: unknown) {
    sendError(
      res,
      error instanceof Error ? error.message : "Failed to create subscription",
      500,
      error,
    );
  }
}

export async function cancelSuperadminSubscription(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { subscriptionId } = req.params as { subscriptionId: string };
    const body = req.body as SubscriptionActionBody;
    const cancelAtPeriodEnd = body.cancelAtPeriodEnd !== false;

    const subscription = cancelAtPeriodEnd
      ? await stripeClient.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
        })
      : await stripeClient.subscriptions.cancel(subscriptionId);

    await prisma.websiteSubscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: {
        status: subscription.status,
        currentPeriodEnd: dateFromUnix(
          (subscription as StripeSubscriptionPeriod).current_period_end,
        ),
      },
    });

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.subscription.cancel",
      targetType: "StripeSubscription",
      targetId: subscriptionId,
      details: { cancelAtPeriodEnd },
    });

    sendSuccess(res, serializeSubscription(subscription), "Subscription canceled");
  } catch (error: unknown) {
    sendError(res, "Failed to cancel subscription", 500, error);
  }
}

export async function reactivateSuperadminSubscription(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { subscriptionId } = req.params as { subscriptionId: string };
    const subscription = await stripeClient.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
      pause_collection: "",
    });

    await prisma.websiteSubscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: {
        status: subscription.status,
        currentPeriodEnd: dateFromUnix(
          (subscription as StripeSubscriptionPeriod).current_period_end,
        ),
      },
    });

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.subscription.reactivate",
      targetType: "StripeSubscription",
      targetId: subscriptionId,
    });

    sendSuccess(
      res,
      serializeSubscription(subscription),
      "Subscription reactivated",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to reactivate subscription", 500, error);
  }
}

export async function pauseSuperadminSubscription(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { subscriptionId } = req.params as { subscriptionId: string };
    const subscription = await stripeClient.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: "void" },
    });

    await prisma.websiteSubscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: { status: "paused" },
    });

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.subscription.pause",
      targetType: "StripeSubscription",
      targetId: subscriptionId,
    });

    sendSuccess(res, serializeSubscription(subscription), "Subscription paused");
  } catch (error: unknown) {
    sendError(res, "Failed to pause subscription", 500, error);
  }
}

export async function updateSuperadminSubscriptionPrice(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { subscriptionId } = req.params as { subscriptionId: string };
    const body = req.body as SubscriptionActionBody;
    const priceId = cleanString(body.priceId);

    if (!priceId) {
      sendError(res, "priceId is required", 400);
      return;
    }

    const existing = await stripeClient.subscriptions.retrieve(subscriptionId);
    const firstItem = existing.items.data[0];
    if (!firstItem?.id) {
      sendError(res, "Subscription has no editable subscription item", 409);
      return;
    }

    const subscription = await stripeClient.subscriptions.update(subscriptionId, {
      items: [{ id: firstItem.id, price: priceId }],
      automatic_tax: { enabled: true },
      proration_behavior: "always_invoice",
    });

    await prisma.websiteSubscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: {
        status: subscription.status,
        stripePriceId: priceId,
        currentPeriodEnd: dateFromUnix(
          (subscription as StripeSubscriptionPeriod).current_period_end,
        ),
      },
    });

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.subscription.update_price",
      targetType: "StripeSubscription",
      targetId: subscriptionId,
      details: { priceId, prorationBehavior: "always_invoice" },
    });

    sendSuccess(res, serializeSubscription(subscription), "Subscription price updated");
  } catch (error: unknown) {
    sendError(res, "Failed to update subscription price", 500, error);
  }
}

export async function createSuperadminInvoice(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const body = req.body as CreateAdminInvoiceBody;
    const businessId = cleanString(body.businessId);
    const currency = cleanString(body.currency).toLowerCase() || "cad";
    const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
    const daysUntilDue = parsePositiveInteger(body.daysUntilDue, 7);

    if (!businessId) {
      sendError(res, "businessId is required", 400);
      return;
    }

    if (lineItems.length === 0) {
      sendError(res, "At least one invoice line item is required", 400);
      return;
    }

    if (!/^[a-z]{3}$/.test(currency)) {
      sendError(res, "currency must be a 3-letter ISO currency code", 400);
      return;
    }

    const normalizedLineItems = lineItems.map((line) => {
      const description = cleanString(line.description);
      const amountCents =
        parseAmountCents(line.amountCents) ?? parseAmountUsdToCents(line.amountUsd);
      const quantity = parsePositiveInteger(line.quantity, 1);
      return { description, amountCents, quantity };
    });

    if (
      normalizedLineItems.some(
        (line) => !line.description || !line.amountCents || line.amountCents <= 0,
      )
    ) {
      sendError(
        res,
        "Each line item needs a description and amount greater than zero",
        400,
      );
      return;
    }

    const business = await getBusinessForBilling(businessId);
    if (!business) {
      sendError(res, "Business not found", 404);
      return;
    }

    const customer = await getOrCreateStripeCustomer({
      stripeClient,
      business,
      billingAddress: body.billingAddress,
    });
    if (!customer) {
      sendError(res, "Stripe customer is deleted or unavailable", 409);
      return;
    }

    const metadata: Record<string, string> = {
      userId: business.userId,
      businessId: business.id,
      businessName: business.businessName,
      source: "superadmin",
      type: "admin_invoice",
    };
    if (business.agencyId) {
      metadata.agencyId = business.agencyId;
    }

    for (const line of normalizedLineItems) {
      await stripeClient.invoiceItems.create({
        customer: customer.id,
        amount: line.amountCents! * line.quantity,
        currency,
        description: line.quantity > 1
          ? `${line.description} x ${line.quantity}`
          : line.description,
        tax_behavior: "exclusive",
        metadata,
      });
    }

    let invoice = await stripeClient.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: daysUntilDue,
      pending_invoice_items_behavior: "include",
      automatic_tax: { enabled: true },
      auto_advance: false,
      description: cleanString(body.memo) || undefined,
      metadata,
    });

    if (body.sendNow !== false) {
      invoice = await stripeClient.invoices.finalizeInvoice(invoice.id);
      invoice = await stripeClient.invoices.sendInvoice(invoice.id);
    }

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.invoice.create",
      targetType: "StripeInvoice",
      targetId: invoice.id,
      details: {
        businessId,
        lineItemCount: normalizedLineItems.length,
        daysUntilDue,
        sendNow: body.sendNow !== false,
        automaticTax: true,
      },
    });

    sendSuccess(res, serializeInvoice(invoice), "Invoice created", 201);
  } catch (error: unknown) {
    sendError(
      res,
      error instanceof Error ? error.message : "Failed to create invoice",
      500,
      error,
    );
  }
}

export async function sendSuperadminInvoice(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { invoiceId } = req.params as { invoiceId: string };
    let invoice = await stripeClient.invoices.retrieve(invoiceId);
    if (invoice.status === "draft") {
      invoice = await stripeClient.invoices.finalizeInvoice(invoiceId);
    }
    invoice = await stripeClient.invoices.sendInvoice(invoice.id);

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.invoice.send",
      targetType: "StripeInvoice",
      targetId: invoice.id,
    });

    sendSuccess(res, serializeInvoice(invoice), "Invoice sent");
  } catch (error: unknown) {
    sendError(res, "Failed to send invoice", 500, error);
  }
}

export async function markSuperadminInvoicePaid(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { invoiceId } = req.params as { invoiceId: string };
    const invoice = await stripeClient.invoices.pay(invoiceId, {
      paid_out_of_band: true,
    });

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.invoice.mark_paid",
      targetType: "StripeInvoice",
      targetId: invoice.id,
    });

    sendSuccess(res, serializeInvoice(invoice), "Invoice marked paid");
  } catch (error: unknown) {
    sendError(res, "Failed to mark invoice paid", 500, error);
  }
}

export async function markSuperadminInvoiceUncollectible(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const stripeClient = requireStripe(res);
    if (!stripeClient) return;

    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { invoiceId } = req.params as { invoiceId: string };
    const invoice = await stripeClient.invoices.markUncollectible(invoiceId);

    await writeBillingAuditLog({
      adminUserId,
      action: "billing.invoice.mark_uncollectible",
      targetType: "StripeInvoice",
      targetId: invoice.id,
    });

    sendSuccess(res, serializeInvoice(invoice), "Invoice marked uncollectible");
  } catch (error: unknown) {
    sendError(res, "Failed to mark invoice uncollectible", 500, error);
  }
}
