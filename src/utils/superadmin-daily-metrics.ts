import {
  commandDayForDate,
  commandDays,
} from "../command/toronto-period";

export type DailyUserStatus = "paid" | "trial" | "expired";

export type DailyUserMetricRow = {
  date: string;
  signups: number;
  paidNow: number;
  trialNow: number;
  expiredNow: number;
};

export type DailyUserMetricInput = {
  createdAt: Date;
  status: DailyUserStatus;
};

export function buildDailyUserMetrics(input: {
  users: DailyUserMetricInput[];
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}) {
  const rows = new Map<string, DailyUserMetricRow>(
    commandDays(input.from, input.to).map((date) => [
      date,
      { date, signups: 0, paidNow: 0, trialNow: 0, expiredNow: 0 },
    ]),
  );
  const summary = {
    totalUsers: input.users.length,
    totalPaid: 0,
    totalTrial: 0,
    totalExpired: 0,
  };
  let currentTotal = 0;
  let previousTotal = 0;
  let firstSignupDay: string | null = null;

  for (const user of input.users) {
    if (user.status === "paid") summary.totalPaid += 1;
    else if (user.status === "trial") summary.totalTrial += 1;
    else summary.totalExpired += 1;

    const date = commandDayForDate(user.createdAt);
    if (firstSignupDay === null || date < firstSignupDay) firstSignupDay = date;
    if (date >= input.previousFrom && date <= input.previousTo) {
      previousTotal += 1;
    }
    const row = rows.get(date);
    if (!row) continue;
    row.signups += 1;
    currentTotal += 1;
    if (user.status === "paid") row.paidNow += 1;
    else if (user.status === "trial") row.trialNow += 1;
    else row.expiredNow += 1;
  }

  return {
    items: [...rows.values()].sort((left, right) =>
      right.date.localeCompare(left.date),
    ),
    currentTotal,
    previousTotal,
    firstSignupDay,
    summary,
  };
}

export type DailyPaymentMetricInput = {
  paidAt: Date;
  amountPaidMinor: number;
  currency: string;
  billingReason: string | null;
};

export type DailyPaymentMetricRow = {
  date: string;
  count: number;
  newSubscriptionCount: number;
  amountByCurrency: Record<string, number>;
};

export function buildDailyPaymentMetrics(input: {
  payments: DailyPaymentMetricInput[];
  from: string;
  to: string;
}) {
  const rows = new Map<string, DailyPaymentMetricRow>(
    commandDays(input.from, input.to).map((date) => [
      date,
      { date, count: 0, newSubscriptionCount: 0, amountByCurrency: {} },
    ]),
  );
  const totalByCurrency: Record<string, number> = {};
  let totalCount = 0;
  let totalNewSubscriptions = 0;

  for (const payment of input.payments) {
    if (!Number.isFinite(payment.amountPaidMinor) || payment.amountPaidMinor <= 0) {
      continue;
    }
    const row = rows.get(commandDayForDate(payment.paidAt));
    if (!row) continue;
    const currency = payment.currency.toLowerCase() || "usd";
    row.count += 1;
    totalCount += 1;
    if (payment.billingReason === "subscription_create") {
      row.newSubscriptionCount += 1;
      totalNewSubscriptions += 1;
    }
    row.amountByCurrency[currency] =
      (row.amountByCurrency[currency] ?? 0) + payment.amountPaidMinor;
    totalByCurrency[currency] =
      (totalByCurrency[currency] ?? 0) + payment.amountPaidMinor;
  }

  return {
    items: [...rows.values()].sort((left, right) =>
      right.date.localeCompare(left.date),
    ),
    totalCount,
    totalNewSubscriptions,
    totalByCurrency,
  };
}
