import { Prisma } from "@prisma/client";

export type ActivityCounts = {
  calls: number;
  connects: number;
  meetingsBooked: number;
  meetingsHeld: number;
};

function ratio(numerator: number, denominator: number): string | null {
  if (denominator === 0) return null;
  return new Prisma.Decimal(numerator)
    .mul(100)
    .div(denominator)
    .toDecimalPlaces(2)
    .toString();
}

function perClose(value: number, closes: number): string | null {
  if (closes === 0) return null;
  return new Prisma.Decimal(value).div(closes).toDecimalPlaces(2).toString();
}

export function activityRatios(activity: ActivityCounts, closes: number) {
  return {
    connectRatePercent: ratio(activity.connects, activity.calls),
    showRatePercent: ratio(activity.meetingsHeld, activity.meetingsBooked),
    callsPerClose: perClose(activity.calls, closes),
    meetingsPerClose: perClose(activity.meetingsHeld, closes),
  };
}
