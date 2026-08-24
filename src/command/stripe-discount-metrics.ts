import { Prisma } from "@prisma/client";
import type Stripe from "stripe";

export type ResolvedStripeDiscount = {
  id: string;
  label: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  amountOffCurrency: string | null;
  amountOffByCurrency: Record<string, number>;
  appliesToProductIds: string[];
  duration: string;
  durationInMonths: number | null;
};

export type UpliftSubscriptionPlanBilling = {
  priceId: string;
  currency: string;
  grossMonthlyMinor: Prisma.Decimal;
  netMonthlyMinor: Prisma.Decimal;
  discountMonthlyMinor: Prisma.Decimal;
  discounts: ResolvedStripeDiscount[];
};

type RecurringItem = {
  priceId: string;
  productId: string | null;
  currency: string;
  recurring: NonNullable<Stripe.Price["recurring"]>;
  grossMonthlyMinor: Prisma.Decimal;
  netMonthlyMinor: Prisma.Decimal;
  discountIds: string[];
};

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  return null;
}

function monthlyAmount(
  amountMinor: Prisma.Decimal,
  recurring: NonNullable<Stripe.Price["recurring"]>,
): Prisma.Decimal {
  const intervalCount = new Prisma.Decimal(recurring.interval_count || 1);
  switch (recurring.interval) {
    case "day":
      return amountMinor.mul(365).div(12).div(intervalCount);
    case "week":
      return amountMinor.mul(52).div(12).div(intervalCount);
    case "month":
      return amountMinor.div(intervalCount);
    case "year":
      return amountMinor.div(12).div(intervalCount);
    default:
      return new Prisma.Decimal(0);
  }
}

function couponAppliesToItem(
  discount: ResolvedStripeDiscount,
  item: RecurringItem,
): boolean {
  return (
    discount.appliesToProductIds.length === 0 ||
    (item.productId !== null &&
      discount.appliesToProductIds.includes(item.productId))
  );
}

function fixedDiscountMonthly(
  discount: ResolvedStripeDiscount,
  item: RecurringItem,
): Prisma.Decimal {
  const currency = item.currency.toLowerCase();
  const currencyOption = discount.amountOffByCurrency[currency];
  const amount =
    currencyOption ??
    (discount.amountOffCurrency?.toLowerCase() === currency
      ? discount.amountOffMinor
      : null);
  return amount === null
    ? new Prisma.Decimal(0)
    : monthlyAmount(new Prisma.Decimal(amount), item.recurring);
}

function applyDiscountToItems(
  items: RecurringItem[],
  discount: ResolvedStripeDiscount,
): void {
  const eligible = items.filter((item) => couponAppliesToItem(discount, item));
  if (eligible.length === 0) return;

  if (discount.percentOff !== null) {
    const multiplier = new Prisma.Decimal(100)
      .sub(discount.percentOff)
      .div(100);
    for (const item of eligible) {
      const before = item.netMonthlyMinor;
      item.netMonthlyMinor = Prisma.Decimal.max(
        new Prisma.Decimal(0),
        before.mul(multiplier),
      );
      if (!before.eq(item.netMonthlyMinor)) item.discountIds.push(discount.id);
    }
    return;
  }

  const representative = eligible[0];
  if (!representative) return;
  const available = eligible.reduce(
    (total, item) => total.add(item.netMonthlyMinor),
    new Prisma.Decimal(0),
  );
  const fixed = Prisma.Decimal.min(
    available,
    fixedDiscountMonthly(discount, representative),
  );
  if (fixed.lte(0) || available.lte(0)) return;

  for (const item of eligible) {
    const share = item.netMonthlyMinor.div(available);
    const allocated = fixed.mul(share);
    item.netMonthlyMinor = Prisma.Decimal.max(
      new Prisma.Decimal(0),
      item.netMonthlyMinor.sub(allocated),
    );
    if (allocated.gt(0)) item.discountIds.push(discount.id);
  }
}

export function projectUpliftSubscriptionPlanBilling(input: {
  subscription: Stripe.Subscription;
  upliftPriceIds: ReadonlySet<string>;
  discountsById: ReadonlyMap<string, ResolvedStripeDiscount>;
}): UpliftSubscriptionPlanBilling[] {
  const items: RecurringItem[] = input.subscription.items.data.flatMap((item) => {
    const recurring = item.price.recurring;
    if (!recurring) return [];
    const unitAmount = new Prisma.Decimal(
      String(item.price.unit_amount_decimal ?? item.price.unit_amount ?? 0),
    );
    const grossMonthlyMinor = monthlyAmount(
      unitAmount.mul(item.quantity ?? 1),
      recurring,
    );
    const projected: RecurringItem = {
      priceId: item.price.id,
      productId: objectId(item.price.product),
      currency: item.price.currency.toLowerCase(),
      recurring,
      grossMonthlyMinor,
      netMonthlyMinor: grossMonthlyMinor,
      discountIds: [],
    };
    for (const entry of item.discounts ?? []) {
      const discount = input.discountsById.get(objectId(entry) ?? "");
      if (discount) applyDiscountToItems([projected], discount);
    }
    return [projected];
  });

  for (const entry of input.subscription.discounts ?? []) {
    const discount = input.discountsById.get(objectId(entry) ?? "");
    if (discount) applyDiscountToItems(items, discount);
  }

  const byPriceId = new Map<string, UpliftSubscriptionPlanBilling>();
  for (const item of items) {
    if (!input.upliftPriceIds.has(item.priceId)) continue;
    const existing = byPriceId.get(item.priceId) ?? {
      priceId: item.priceId,
      currency: item.currency,
      grossMonthlyMinor: new Prisma.Decimal(0),
      netMonthlyMinor: new Prisma.Decimal(0),
      discountMonthlyMinor: new Prisma.Decimal(0),
      discounts: [],
    };
    existing.grossMonthlyMinor = existing.grossMonthlyMinor.add(
      item.grossMonthlyMinor,
    );
    existing.netMonthlyMinor = existing.netMonthlyMinor.add(item.netMonthlyMinor);
    existing.discountMonthlyMinor = existing.discountMonthlyMinor.add(
      item.grossMonthlyMinor.sub(item.netMonthlyMinor),
    );
    const knownIds = new Set(existing.discounts.map((discount) => discount.id));
    for (const id of item.discountIds) {
      const discount = input.discountsById.get(id);
      if (discount && !knownIds.has(id)) {
        existing.discounts.push(discount);
        knownIds.add(id);
      }
    }
    byPriceId.set(item.priceId, existing);
  }
  return [...byPriceId.values()];
}

export function resolveStripeDiscount(input: {
  discount: Stripe.Discount;
  coupon: Stripe.Coupon | null;
  promotionCode: Stripe.PromotionCode | null;
}): ResolvedStripeDiscount | null {
  const coupon = input.coupon;
  if (!coupon || coupon.deleted) return null;
  const amountOffByCurrency = Object.fromEntries(
    Object.entries(coupon.currency_options ?? {}).map(([currency, option]) => [
      currency.toLowerCase(),
      option.amount_off,
    ]),
  );
  return {
    id: input.discount.id,
    label:
      input.promotionCode?.code?.trim() ||
      coupon.name?.trim() ||
      coupon.id,
    percentOff: coupon.percent_off,
    amountOffMinor: coupon.amount_off,
    amountOffCurrency: coupon.currency?.toLowerCase() ?? null,
    amountOffByCurrency,
    appliesToProductIds: coupon.applies_to?.products ?? [],
    duration: coupon.duration,
    durationInMonths: coupon.duration_in_months,
  };
}
