import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import {
  majorToMinorExact,
  mergeMajorCurrencyBucketsIntoMinor,
} from "../command/money";

describe("Command exact money conversion", () => {
  it("converts provider major units without binary floating point", () => {
    expect(majorToMinorExact(new Prisma.Decimal("99.90"), "cad").toString()).toBe("9990");
    expect(majorToMinorExact(new Prisma.Decimal("100"), "jpy").toString()).toBe("100");
  });

  it("rejects precision the currency cannot represent", () => {
    expect(() => majorToMinorExact(new Prisma.Decimal("1.001"), "cad")).toThrow(
      "more precision",
    );
  });

  it("keeps currencies separate while adding GHL recurring revenue", () => {
    expect(
      mergeMajorCurrencyBucketsIntoMinor({
        minorByCurrency: { cad: "14900", usd: "9900" },
        majorByCurrency: { CAD: "99.00" },
      }),
    ).toEqual({
      combinedMinorByCurrency: { cad: "24800", usd: "9900" },
      addedMinorByCurrency: { cad: "9900" },
    });
  });
});
