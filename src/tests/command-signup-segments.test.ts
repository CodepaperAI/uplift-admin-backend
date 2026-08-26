import { describe, expect, test } from "bun:test";
import {
  classifyCountry,
  classifyPlanTag,
  stageFromPaymentState,
  tallySegments,
} from "../command/signup-segments";

const SOCIAL = new Set(["price_social_m", "price_social_y"]);
const ANNUAL = new Set(["price_core_y", "price_social_y"]);

describe("stageFromPaymentState", () => {
  test("no subscription is the top of the funnel", () => {
    expect(stageFromPaymentState("none")).toBe("signed_up");
  });

  test("a coupon payer is a customer, not a prospect", () => {
    // Somebody paying $74 a month is active. The discount is a margin question
    // and stays visible in the amount, not in the funnel stage.
    expect(stageFromPaymentState("discounted")).toBe("active");
    expect(stageFromPaymentState("paid")).toBe("active");
  });

  test("trial, unbilled and churned each stay distinct", () => {
    expect(stageFromPaymentState("trial")).toBe("trial");
    expect(stageFromPaymentState("pending")).toBe("unbilled");
    expect(stageFromPaymentState("cancelled")).toBe("churned");
  });
});

describe("classifyPlanTag", () => {
  const base = {
    socialPriceIds: SOCIAL,
    annualPriceIds: ANNUAL,
    hasSubscription: true,
  };

  test("no subscription means no plan", () => {
    expect(
      classifyPlanTag({ ...base, stage: "signed_up", priceIds: [], hasSubscription: false }),
    ).toBe("none");
  });

  test("the trial charge is its own tag, not the plan it will become", () => {
    expect(
      classifyPlanTag({ ...base, stage: "trial", priceIds: ["price_social_m"] }),
    ).toBe("trial");
  });

  test("core and social are split, monthly and annual too", () => {
    expect(classifyPlanTag({ ...base, stage: "active", priceIds: ["price_core_m"] })).toBe("other");
    expect(classifyPlanTag({ ...base, stage: "active", priceIds: ["price_core_y"] })).toBe("core_annual");
    expect(classifyPlanTag({ ...base, stage: "active", priceIds: ["price_social_m"] })).toBe("social_monthly");
    expect(classifyPlanTag({ ...base, stage: "active", priceIds: ["price_social_y"] })).toBe("social_annual");
  });

  test("an unrecognised price is reported, never folded into core", () => {
    // Folding unknown prices into core is exactly how the whole SEO+Social
    // line once vanished from the plan chart.
    expect(
      classifyPlanTag({ ...base, stage: "active", priceIds: ["price_mystery"] }),
    ).toBe("other");
  });

  test("social wins when a subscription carries both prices", () => {
    expect(
      classifyPlanTag({
        ...base,
        stage: "active",
        priceIds: ["price_core_y", "price_social_m"],
      }),
    ).toBe("social_monthly");
  });
});

describe("classifyCountry", () => {
  test("a declared business country wins", () => {
    expect(classifyCountry({ businessCountry: "India" })).toEqual({
      country: "india",
      source: "business",
    });
    expect(classifyCountry({ businessCountry: "Canada" })).toEqual({
      country: "rest_of_world",
      source: "business",
    });
  });

  test("India is recognised however it is written", () => {
    for (const value of ["IN", "in", " india ", "Bharat", "Republic of India"]) {
      expect(classifyCountry({ businessCountry: value }).country).toBe("india");
    }
  });

  test("an international dialling code is the fallback", () => {
    expect(classifyCountry({ phone: "+917908481126" })).toEqual({
      country: "india",
      source: "phone",
    });
    expect(classifyCountry({ phone: "+1 437 249 7854" })).toEqual({
      country: "rest_of_world",
      source: "phone",
    });
    // Pakistan is not India, and a prefix test that only looks at "+9" would
    // put it there.
    expect(classifyCountry({ phone: "+923469789611" }).country).toBe(
      "rest_of_world",
    );
  });

  test("the business country beats a contradicting phone", () => {
    expect(
      classifyCountry({ businessCountry: "Canada", phone: "+919999999999" })
        .country,
    ).toBe("rest_of_world");
  });

  test("a bare local number is unknown, never guessed", () => {
    // Ten digits could be Toronto or Mumbai. Guessing would file real Canadian
    // customers under India.
    expect(classifyCountry({ phone: "9054042367" })).toEqual({
      country: "unknown",
      source: null,
    });
    expect(classifyCountry({ phone: "6479283524" }).country).toBe("unknown");
  });

  test("nothing at all is unknown, not rest of world", () => {
    // Sweeping the unknown into "rest of world" would quietly inflate it.
    expect(classifyCountry({}).country).toBe("unknown");
    expect(classifyCountry({ phone: "", businessCountry: "" }).country).toBe(
      "unknown",
    );
    expect(classifyCountry({ phone: "   " }).country).toBe("unknown");
  });
});

describe("tallySegments", () => {
  test("counts all three dimensions of the same rows", () => {
    const totals = tallySegments([
      { stage: "active", planTag: "social_monthly", country: "rest_of_world" },
      { stage: "active", planTag: "core_monthly", country: "india" },
      { stage: "signed_up", planTag: "none", country: "unknown" },
      { stage: "trial", planTag: "trial", country: "india" },
    ]);
    expect(totals.stage).toMatchObject({ active: 2, signed_up: 1, trial: 1, churned: 0 });
    expect(totals.plan).toMatchObject({ social_monthly: 1, core_monthly: 1, none: 1, trial: 1 });
    expect(totals.country).toEqual({ india: 2, rest_of_world: 1, unknown: 1 });
  });
});
