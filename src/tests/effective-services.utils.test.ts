import { describe, expect, it } from "bun:test";
import {
  buildServicesPriorityFromOrder,
  resolveEffectiveServices,
  resolveOrderedSelectedServices,
} from "../utils/effective-services.utils";

describe("effective service resolution", () => {
  it("orders selected services by priority and falls back to selection order", () => {
    expect(
      resolveOrderedSelectedServices(
        ["SEO", "Local SEO", "Technical SEO"],
        { "Technical SEO": 1, SEO: 2, "Local SEO": 3 },
      ),
    ).toEqual(["Technical SEO", "SEO", "Local SEO"]);

    expect(
      resolveOrderedSelectedServices(
        ["SEO", "Local SEO", "Technical SEO"],
        undefined,
      ),
    ).toEqual(["SEO", "Local SEO", "Technical SEO"]);
  });

  it("merges selected services ahead of scraped and detected services without duplicates", () => {
    const effective = resolveEffectiveServices({
      selectedServices: ["Event Venue", "Banquet Hall"],
      servicesPriority: buildServicesPriorityFromOrder([
        "Banquet Hall",
        "Event Venue",
      ]),
      detectedServices: ["Event Venue", "Wedding Venue"],
      websiteAnalysis: {
        coreServices: {
          topLevel: ["Event Venue", "Corporate Events"],
          subOfferings: ["Banquet Hall", "Outdoor Catering", "Wedding Venue"],
          industryFocus: ["Luxury Events", "Corporate Events"],
        },
      },
    });

    expect(effective.orderedPrimaryServices).toEqual([
      "Banquet Hall",
      "Event Venue",
      "Corporate Events",
      "Wedding Venue",
    ]);
    expect(effective.topLevel).toEqual(effective.orderedPrimaryServices);
    expect(effective.subOfferings).toEqual(["Outdoor Catering"]);
    expect(effective.industryFocus).toEqual(["Luxury Events"]);
  });

  it("falls back to scraped services when no selected services are present", () => {
    const effective = resolveEffectiveServices({
      selectedServices: [],
      websiteAnalysis: {
        coreServices: {
          topLevel: ["Custom Software Development"],
          subOfferings: ["Workflow Automation"],
          industryFocus: ["Manufacturing"],
        },
      },
    });

    expect(effective.orderedPrimaryServices).toEqual([
      "Custom Software Development",
    ]);
    expect(effective.subOfferings).toEqual(["Workflow Automation"]);
    expect(effective.industryFocus).toEqual(["Manufacturing"]);
  });

  it("strips generic e-commerce labels from scraped sources but preserves them in selectedServices", () => {
    const effective = resolveEffectiveServices({
      // selectedServices is user-curated — even if the user explicitly types
      // "Order Delivery" we keep it. They get to override.
      selectedServices: ["Wedding catering", "Order Delivery"],
      detectedServices: ["Pickup", "Halal platters", "Gift Cards"],
      websiteAnalysis: {
        coreServices: {
          topLevel: ["Office lunch boxes", "Online Ordering"],
          subOfferings: ["Drop-off catering", "Returns"],
          industryFocus: ["Corporate clients", "Contact Us"],
        },
      },
    });

    expect(effective.orderedPrimaryServices).toEqual([
      "Wedding catering",
      "Order Delivery", // kept — user-selected
      "Office lunch boxes",
      "Halal platters",
    ]);
    expect(effective.subOfferings).toEqual(["Drop-off catering"]);
    expect(effective.industryFocus).toEqual(["Corporate clients"]);
  });
});
