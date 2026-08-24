import { Prisma } from "@prisma/client";

export function currencyExponent(currency: string): number {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  return formatter.resolvedOptions().maximumFractionDigits ?? 2;
}

export function majorToMinorExact(
  amount: Prisma.Decimal,
  currency: string,
): Prisma.Decimal {
  const minor = amount.mul(new Prisma.Decimal(10).pow(currencyExponent(currency)));
  if (!minor.isInteger()) {
    throw new Error(
      `${currency.toUpperCase()} provider amount has more precision than its minor unit`,
    );
  }
  return minor;
}

export function mergeMajorCurrencyBucketsIntoMinor(input: {
  minorByCurrency: Readonly<Record<string, string>>;
  majorByCurrency: Readonly<Record<string, string>>;
}) {
  const combined = new Map<string, Prisma.Decimal>();
  const added = new Map<string, Prisma.Decimal>();
  for (const [currency, amount] of Object.entries(input.minorByCurrency)) {
    combined.set(currency.toLowerCase(), new Prisma.Decimal(amount));
  }
  for (const [rawCurrency, amount] of Object.entries(input.majorByCurrency)) {
    const currency = rawCurrency.toLowerCase();
    const minor = majorToMinorExact(new Prisma.Decimal(amount), currency);
    added.set(currency, minor);
    combined.set(
      currency,
      (combined.get(currency) ?? new Prisma.Decimal(0)).add(minor),
    );
  }
  const serialize = (values: Map<string, Prisma.Decimal>) =>
    Object.fromEntries(
      [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => [currency, amount.toString()]),
    );
  return {
    combinedMinorByCurrency: serialize(combined),
    addedMinorByCurrency: serialize(added),
  };
}
