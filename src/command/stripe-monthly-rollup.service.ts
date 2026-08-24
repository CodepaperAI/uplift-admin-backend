import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { aggregateStripeMonthlyMovement } from "./stripe-churn";
import { commandMonthRange } from "./toronto-period";

export type CommandStripeMonthlyMovement = ReturnType<
  typeof aggregateStripeMonthlyMovement
>;

function stringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => typeof item === "string"),
  );
}

function nullableStringRecord(
  value: unknown,
): value is Record<string, string | null> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(
        (item) => item === null || typeof item === "string",
      ),
  );
}

export function parseCommandStripeMonthlyMovement(
  value: unknown,
): CommandStripeMonthlyMovement | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !stringRecord(row.openingMrrMinorByCurrency) ||
    !stringRecord(row.newMrrMinorByCurrency) ||
    !stringRecord(row.churnedMrrMinorByCurrency) ||
    !nullableStringRecord(row.revenueChurnPercentByCurrency) ||
    typeof row.openingAccounts !== "number" ||
    typeof row.churnedAccounts !== "number" ||
    (row.logoChurnPercent !== null &&
      typeof row.logoChurnPercent !== "string")
  ) {
    return null;
  }
  return row as CommandStripeMonthlyMovement;
}

export async function refreshCommandStripeMonthlyMovement(
  periodMonth: string,
): Promise<CommandStripeMonthlyMovement> {
  const period = commandMonthRange(periodMonth);
  const [openingFacts, periodFacts] = await Promise.all([
    prisma.commandStripeSubscriptionEvent.findMany({
      where: { occurredAt: { lt: period.start } },
      distinct: ["stripeSubscriptionId"],
      select: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        status: true,
        pauseCollectionBehavior: true,
        monthlyRecurringMinor: true,
        currency: true,
        occurredAt: true,
      },
      orderBy: [
        { stripeSubscriptionId: "asc" },
        { occurredAt: "desc" },
        { createdAt: "desc" },
      ],
    }),
    prisma.commandStripeSubscriptionEvent.findMany({
      where: { occurredAt: { gte: period.start, lt: period.end } },
      select: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        status: true,
        pauseCollectionBehavior: true,
        monthlyRecurringMinor: true,
        currency: true,
        occurredAt: true,
      },
      orderBy: [{ stripeSubscriptionId: "asc" }, { occurredAt: "asc" }],
    }),
  ]);
  const movement = aggregateStripeMonthlyMovement(
    [...openingFacts, ...periodFacts],
    period,
  );
  const generatedAt = new Date();
  await prisma.commandStripeMonthlyRollup.upsert({
    where: { periodMonth },
    create: {
      periodMonth,
      payload: movement as Prisma.InputJsonValue,
      generatedAt,
    },
    update: {
      payload: movement as Prisma.InputJsonValue,
      generatedAt,
    },
  });
  return movement;
}

export async function getCommandStripeMonthlyMovement(
  periodMonth: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): Promise<CommandStripeMonthlyMovement> {
  const maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000;
  const now = options.now ?? new Date();
  const existing = await prisma.commandStripeMonthlyRollup.findUnique({
    where: { periodMonth },
  });
  const parsed = parseCommandStripeMonthlyMovement(existing?.payload);
  if (
    parsed &&
    existing &&
    now.getTime() - existing.generatedAt.getTime() <= maxAgeMs
  ) {
    return parsed;
  }
  return refreshCommandStripeMonthlyMovement(periodMonth);
}
