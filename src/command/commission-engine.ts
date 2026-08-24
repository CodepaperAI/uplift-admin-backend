import { Prisma } from "@prisma/client";
import { commandMonthForDate } from "./toronto-period";

const ZERO = new Prisma.Decimal(0);

export type CommissionRate = {
  id: string;
  firstSaleRate: Prisma.Decimal;
  recurringRate: Prisma.Decimal;
};

export type CommissionDeal = {
  sourceType: string;
  sourceId: string;
  serviceId: string;
  repId: string;
  creditShare: Prisma.Decimal;
  amountMinor: Prisma.Decimal;
  currency: string;
  kind: "subscription" | "one_time";
  startedAt: Date;
  canceledAt: Date | null;
  repDepartedAt: Date | null;
  isPastDueInPeriod: boolean;
  heldMinorToRelease: Prisma.Decimal;
  adjustmentMinor?: Prisma.Decimal;
  rate: CommissionRate;
};

export type CommissionPolicy = {
  periodMonth: string;
  periodStart: Date;
  periodEnd: Date;
  clawbackWindowDays: 0 | 30 | 60 | 90;
  departingRepResiduals: "stop_on_departure" | "continue_residual";
};

export type CalculatedCommissionLine = {
  lineKey: string;
  repId: string;
  serviceId: string;
  rateVersionId: string;
  kind: "first_sale" | "recurring" | "clawback" | "release" | "adjustment";
  status: "earned" | "held" | "released";
  sourceType: string;
  sourceId: string;
  originPeriodMonth: string;
  postedPeriodMonth: string;
  amountMinor: Prisma.Decimal;
  currency: string;
  metadata: Record<string, string | number | boolean | null>;
};

function exactMinor(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

function creditedAmount(
  amount: Prisma.Decimal,
  rate: Prisma.Decimal,
  creditShare: Prisma.Decimal,
): Prisma.Decimal {
  return exactMinor(amount.mul(rate).mul(creditShare));
}

function baseLine(
  deal: CommissionDeal,
  policy: CommissionPolicy,
  kind: CalculatedCommissionLine["kind"],
  status: CalculatedCommissionLine["status"],
  amountMinor: Prisma.Decimal,
  originPeriodMonth = policy.periodMonth,
): CalculatedCommissionLine {
  return {
    lineKey: [
      policy.periodMonth,
      deal.sourceType,
      deal.sourceId,
      deal.repId,
      deal.serviceId,
      kind,
      originPeriodMonth,
    ].join(":"),
    repId: deal.repId,
    serviceId: deal.serviceId,
    rateVersionId: deal.rate.id,
    kind,
    status,
    sourceType: deal.sourceType,
    sourceId: deal.sourceId,
    originPeriodMonth,
    postedPeriodMonth: policy.periodMonth,
    amountMinor: exactMinor(amountMinor),
    currency: deal.currency.toLowerCase(),
    metadata: {
      creditShare: deal.creditShare.toString(),
      amountMinor: deal.amountMinor.toString(),
      firstSaleRate: deal.rate.firstSaleRate.toString(),
      recurringRate: deal.rate.recurringRate.toString(),
    },
  };
}

export function calculateDealCommissionLines(
  deal: CommissionDeal,
  policy: CommissionPolicy,
): CalculatedCommissionLine[] {
  if (deal.startedAt >= policy.periodEnd) return [];
  const startedMonth = commandMonthForDate(deal.startedAt);
  const cancellationMonth = deal.canceledAt
    ? commandMonthForDate(deal.canceledAt)
    : null;
  const residualStoppedForDeparture =
    policy.departingRepResiduals === "stop_on_departure" &&
    deal.repDepartedAt !== null &&
    deal.repDepartedAt < policy.periodEnd;
  const firstSaleStoppedForDeparture =
    policy.departingRepResiduals === "stop_on_departure" &&
    deal.repDepartedAt !== null &&
    deal.startedAt >= deal.repDepartedAt;
  const lines: CalculatedCommissionLine[] = [];

  if (startedMonth === policy.periodMonth && !firstSaleStoppedForDeparture) {
    const firstSale = creditedAmount(
      deal.amountMinor,
      deal.rate.firstSaleRate,
      deal.creditShare,
    );
    if (!firstSale.isZero()) {
      lines.push(
        baseLine(
          deal,
          policy,
          "first_sale",
          deal.isPastDueInPeriod ? "held" : "earned",
          firstSale,
        ),
      );
    }
  }

  const recurringEligible =
    deal.kind === "subscription" &&
    startedMonth < policy.periodMonth &&
    (cancellationMonth === null || cancellationMonth > policy.periodMonth) &&
    !residualStoppedForDeparture;
  if (recurringEligible) {
    const recurring = creditedAmount(
      deal.amountMinor,
      deal.rate.recurringRate,
      deal.creditShare,
    );
    if (!recurring.isZero()) {
      lines.push(
        baseLine(
          deal,
          policy,
          "recurring",
          deal.isPastDueInPeriod ? "held" : "earned",
          recurring,
        ),
      );
    }
  }

  if (
    deal.canceledAt &&
    cancellationMonth === policy.periodMonth &&
    policy.clawbackWindowDays > 0
  ) {
    const ageDays = Math.floor(
      (deal.canceledAt.getTime() - deal.startedAt.getTime()) / 86_400_000,
    );
    if (ageDays >= 0 && ageDays <= policy.clawbackWindowDays) {
      const clawback = creditedAmount(
        deal.amountMinor,
        deal.rate.firstSaleRate,
        deal.creditShare,
      ).negated();
      if (!clawback.isZero()) {
        lines.push(
          baseLine(deal, policy, "clawback", "earned", clawback, startedMonth),
        );
      }
    }
  }

  if (deal.heldMinorToRelease.gt(0) && !deal.isPastDueInPeriod) {
    lines.push(
      baseLine(
        deal,
        policy,
        "release",
        "released",
        deal.heldMinorToRelease,
        "prior_locked_period",
      ),
    );
  }

  if (deal.adjustmentMinor && !deal.adjustmentMinor.isZero()) {
    lines.push(
      baseLine(
        deal,
        policy,
        "adjustment",
        "earned",
        exactMinor(deal.adjustmentMinor.mul(deal.creditShare)),
        "approved_open_period_adjustment",
      ),
    );
  }

  return lines;
}

export type DrawPolicy = "recoverable" | "non_recoverable";

export function summarizeRepCommission(input: {
  lines: readonly CalculatedCommissionLine[];
  baseDrawMinor: Prisma.Decimal;
  openingDrawBalanceMinor: Prisma.Decimal;
  drawPolicy: DrawPolicy;
  firstSaleCommissionPerCloseMinor?: Prisma.Decimal | null;
}) {
  const sumKind = (kind: CalculatedCommissionLine["kind"]) =>
    input.lines
      .filter((line) => line.kind === kind && line.status !== "held")
      .reduce((total, line) => total.add(line.amountMinor), ZERO);
  const heldMinor = input.lines
    .filter((line) => line.status === "held")
    .reduce((total, line) => total.add(line.amountMinor), ZERO);
  const firstSaleMinor = sumKind("first_sale");
  const recurringMinor = sumKind("recurring");
  const clawbackMinor = sumKind("clawback");
  const releasedMinor = sumKind("release");
  const adjustmentMinor = sumKind("adjustment");
  const earnedMinor = exactMinor(
    firstSaleMinor
      .add(recurringMinor)
      .add(clawbackMinor)
      .add(releasedMinor)
      .add(adjustmentMinor),
  );
  const drawDifferentialMinor = exactMinor(earnedMinor.sub(input.baseDrawMinor));

  let closingDrawBalanceMinor = ZERO;
  let drawRecoveryMinor = ZERO;
  if (input.drawPolicy === "recoverable") {
    const shortfall = Prisma.Decimal.max(input.baseDrawMinor.sub(earnedMinor), ZERO);
    const surplus = Prisma.Decimal.max(earnedMinor.sub(input.baseDrawMinor), ZERO);
    drawRecoveryMinor = Prisma.Decimal.min(input.openingDrawBalanceMinor, surplus);
    closingDrawBalanceMinor = exactMinor(
      input.openingDrawBalanceMinor.add(shortfall).sub(drawRecoveryMinor),
    );
  }
  const cashPayableMinor = exactMinor(
    Prisma.Decimal.max(earnedMinor, input.baseDrawMinor).sub(drawRecoveryMinor),
  );
  const remainingToDraw = Prisma.Decimal.max(input.baseDrawMinor.sub(earnedMinor), ZERO);
  const perClose = input.firstSaleCommissionPerCloseMinor ?? null;
  const closesNeeded =
    perClose && perClose.gt(0)
      ? Number(remainingToDraw.div(perClose).ceil().toFixed(0))
      : null;

  return {
    firstSaleMinor: exactMinor(firstSaleMinor),
    recurringMinor: exactMinor(recurringMinor),
    clawbackMinor: exactMinor(clawbackMinor),
    heldMinor: exactMinor(heldMinor),
    releasedMinor: exactMinor(releasedMinor),
    adjustmentMinor: exactMinor(adjustmentMinor),
    earnedMinor,
    baseDrawMinor: exactMinor(input.baseDrawMinor),
    drawDifferentialMinor,
    drawRecoveryMinor: exactMinor(drawRecoveryMinor),
    openingDrawBalanceMinor: exactMinor(input.openingDrawBalanceMinor),
    closingDrawBalanceMinor,
    cashPayableMinor,
    closesNeeded,
  };
}
