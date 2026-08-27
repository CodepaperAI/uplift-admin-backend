import { describe, expect, test } from "bun:test";
import {
  INTRO_PERIOD_MAX_DAYS,
  classifyCountry,
  classifyPlanTag,
  isIntroPeriod,
  stageFromPaymentState,
  tallySegments,
} from "../command/signup-segments";

const SOCIAL = new Set(["price_social_m", "price_social_y"]);
const ANNUAL = new Set(["price_core_y", "price_social_y"]);

describe("stageFromPaymentState", () => {
  // A month out. Long enough that no state should read it as an intro window.
  const SETTLED_CYCLE = 31;

  test("no subscription is the top of the funnel", () => {
    expect(stageFromPaymentState("none", null)).toBe("signed_up");
  });

  test("a coupon payer is a customer, not a prospect", () => {
    // Somebody paying $74 a month is active. The discount is a margin question
    // and stays visible in the amount, not in the funnel stage.
    expect(stageFromPaymentState("discounted", SETTLED_CYCLE)).toBe("active");
    expect(stageFromPaymentState("paid", SETTLED_CYCLE)).toBe("active");
  });

  test("trial and churned are read from the state alone", () => {
    expect(stageFromPaymentState("trial", SETTLED_CYCLE)).toBe("trial");
    expect(stageFromPaymentState("cancelled", null)).toBe("churned");
  });

  /**
   * The case this whole argument exists for. On 2026-08-26 ten accounts held
   * $99 and $149 subscriptions, every one billing three days after signup with
   * no invoice recorded, and the day reported zero trials and zero paid.
   */
  test("a live subscription billing in three days is on a trial, not unbilled", () => {
    expect(stageFromPaymentState("pending", 3)).toBe("trial");
  });

  test("a pending subscription on a normal cycle has not been billed", () => {
    // Nothing settled and a month-long window is a payment that should have
    // happened. That is a different conversation from a trial in progress.
    expect(stageFromPaymentState("pending", SETTLED_CYCLE)).toBe("unbilled");
    expect(stageFromPaymentState("pending", 365)).toBe("unbilled");
  });

  test("a pending subscription with no bill date at all stays unbilled", () => {
    // Nothing is known about the window, so nothing is claimed about a trial.
    expect(stageFromPaymentState("pending", null)).toBe("unbilled");
  });

  test("the intro window is bounded at both ends", () => {
    // Zero or negative means the date has passed — that is overdue, not intro.
    expect(stageFromPaymentState("pending", 0)).toBe("unbilled");
    expect(stageFromPaymentState("pending", -2)).toBe("unbilled");
    expect(stageFromPaymentState("pending", INTRO_PERIOD_MAX_DAYS)).toBe("trial");
    expect(stageFromPaymentState("pending", INTRO_PERIOD_MAX_DAYS + 1)).toBe(
      "unbilled",
    );
  });
});

describe("isIntroPeriod", () => {
  test("the window sits well clear of the shortest real billing cycle", () => {
    // The gap this rule depends on: nothing on the book renews inside 31 days,
    // so the boundary has three weeks of daylight on either side of it.
    expect(INTRO_PERIOD_MAX_DAYS).toBeLessThan(31);
    expect(isIntroPeriod(31)).toBe(false);
    expect(isIntroPeriod(34)).toBe(false);
    expect(isIntroPeriod(365)).toBe(false);
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
