import { beforeEach, describe, expect, it, mock } from "bun:test";

const cacheFindUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const cacheUpsertMock = mock(async ({ create }: any) => create);
const cacheDeleteManyMock = mock(async () => ({ count: 0 }));

mock.module("../config/db.config", () => ({
  prisma: {
    gMBProfileProposalCache: {
      findUnique: cacheFindUniqueMock,
      upsert: cacheUpsertMock,
      deleteMany: cacheDeleteManyMock,
    },
  },
}));

const llmInvokeMock = mock(async (_messages: unknown): Promise<{ content: unknown }> => ({
  content: "",
}));

import { gmbAIService } from "../services/gmb-ai.service";

// Replace the private proposalLlm field with our mock so we don't hit the
// real OpenAI API. The class-field initializer for `proposalLlm` runs at
// singleton construction time (before mock.module can intercept it), so a
// direct field assignment is the simplest reliable injection.
(gmbAIService as unknown as { proposalLlm: { invoke: typeof llmInvokeMock } }).proposalLlm = {
  invoke: llmInvokeMock,
};

const BASE_INPUT = {
  businessId: "biz-1",
  businessName: "Acme Plumbing",
  businessType: "Plumber",
  description: "Family-owned plumbing serving Brooklyn since 1998.",
  targetAudience: "Brooklyn homeowners",
  city: "Brooklyn",
  state: "NY",
  country: "USA",
  websiteUrl: "https://acmeplumbing.example",
  contextServices: ["Drain cleaning", "Leak repair"],
};

const VALID_LLM_OUTPUT = JSON.stringify({
  description:
    "Acme Plumbing has served Brooklyn homeowners since 1998 with reliable drain cleaning, leak repair, fixture installation, and emergency 24/7 service across all five boroughs. Licensed, insured, and locally owned.",
  categories: ["Plumber", "Emergency plumber"],
  services: [
    {
      displayName: "Drain cleaning",
      description: "Clear clogged drains and restore reliable water flow for Brooklyn homes.",
    },
    {
      displayName: "Leak repair",
      description: "Find and repair plumbing leaks before they damage floors, walls, or fixtures.",
    },
    {
      displayName: "Toilet installation",
      description: "Install and replace toilets with careful fitting, sealing, and cleanup.",
    },
    {
      displayName: "Water heater repair",
      description: "Repair common water heater issues so customers regain dependable hot water.",
    },
  ],
});

describe("gmbAIService.generateProfileProposal — determinism", () => {
  beforeEach(() => {
    cacheFindUniqueMock.mockReset();
    cacheUpsertMock.mockReset();
    cacheUpsertMock.mockImplementation(async ({ create }: any) => create);
    cacheDeleteManyMock.mockReset();
    llmInvokeMock.mockReset();
  });

  it("returns cached proposal when input hash matches", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => ({
      businessId: "biz-1",
      inputHash:
        // Real hash for the BASE_INPUT shape; computed via the same algorithm
        // the service uses internally. Test asserts the cache hit path runs
        // without invoking the LLM.
        await computeExpectedHash(BASE_INPUT),
      proposalJson: {
        description:
          "Cached Acme Plumbing profile description for Brooklyn homeowners needing reliable plumbing help.",
        categories: ["Plumber"],
        // Legacy cache payloads from before service descriptions should still
        // normalize into service objects instead of forcing a fresh LLM call.
        services: ["Drain cleaning", "Leak repair", "Toilet installation"],
      },
      expiresAt: new Date(Date.now() + 60_000),
    }));

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(result.source).toBe("cache");
    expect(result.description).toContain("Cached Acme Plumbing");
    expect(llmInvokeMock).not.toHaveBeenCalled();
    expect(cacheUpsertMock).not.toHaveBeenCalled();
  });

  it("drops raw Google service IDs from cached proposal services", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => ({
      businessId: "biz-1",
      inputHash: await computeExpectedHash(BASE_INPUT),
      proposalJson: {
        description:
          "Cached Acme Plumbing profile description for Brooklyn homeowners needing reliable plumbing help.",
        categories: ["Plumber"],
        services: [
          "job_type_id:home_purchase",
          "Drain cleaning",
          "Leak repair",
          "Toilet installation",
          "Water heater repair",
        ],
      },
      expiresAt: new Date(Date.now() + 60_000),
    }));

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(result.source).toBe("cache");
    expect(result.services.map((service) => service.displayName)).toEqual([
      "Drain cleaning",
      "Leak repair",
      "Toilet installation",
      "Water heater repair",
    ]);
    expect(llmInvokeMock).not.toHaveBeenCalled();
  });

  it("regenerates and persists when input hash drifts", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => ({
      businessId: "biz-1",
      inputHash: "stale-hash-from-old-inputs",
      proposalJson: { description: "stale", categories: ["Old"], services: ["a", "b", "c"] },
      expiresAt: new Date(Date.now() + 60_000),
    }));
    llmInvokeMock.mockImplementationOnce(async () => ({
      content: VALID_LLM_OUTPUT,
    }));

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(result.source).toBe("live");
    expect(result.categories).toEqual(["Plumber", "Emergency plumber"]);
    expect(llmInvokeMock).toHaveBeenCalledTimes(1);
    expect(cacheUpsertMock).toHaveBeenCalledTimes(1);
  });

  it("retries once when first LLM response fails Zod validation", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => null);
    llmInvokeMock
      .mockImplementationOnce(async () => ({
        content: JSON.stringify({
          description: "too short",
          categories: [],
          services: [],
        }),
      }))
      .mockImplementationOnce(async () => ({
        content: VALID_LLM_OUTPUT,
      }));

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(llmInvokeMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("live");
    expect(result.services.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to deterministic shape when both attempts fail validation", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => null);
    llmInvokeMock.mockImplementation(async () => ({
      content: "this is not json at all",
    }));

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(llmInvokeMock).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("fallback");
    // Fallback uses the existing description verbatim so the page renders
    // something useful even when the LLM is fully down.
    expect(result.description).toContain("Brooklyn");
  });

  it("falls back when LLM call throws", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => null);
    llmInvokeMock.mockImplementation(async () => {
      throw new Error("OpenAI 500");
    });

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(result.source).toBe("fallback");
    expect(llmInvokeMock).toHaveBeenCalledTimes(2);
  });

  it("ignores expired cache entries", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => ({
      businessId: "biz-1",
      inputHash: await computeExpectedHash(BASE_INPUT),
      proposalJson: { description: "expired", categories: ["x"], services: ["a", "b", "c"] },
      expiresAt: new Date(Date.now() - 60_000),
    }));
    llmInvokeMock.mockImplementationOnce(async () => ({
      content: VALID_LLM_OUTPUT,
    }));

    const result = await gmbAIService.generateProfileProposal(BASE_INPUT);

    expect(result.source).toBe("live");
  });

  it("rejects generic services hallucinated by the LLM (post-validation strip)", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => null);
    llmInvokeMock.mockImplementationOnce(async () => ({
      content: JSON.stringify({
        description:
          "Shawarma Moose serves halal catering across Brampton with hand-carved shawarma platters, wedding catering, and corporate lunch boxes.",
        categories: ["Caterer", "Halal restaurant"],
        services: [
          { displayName: "Order Delivery", description: "fulfillment label" },
          { displayName: "Pickup", description: "fulfillment label" },
          {
            displayName: "Wedding catering",
            description: "Hand-carved shawarma platters and sides for weddings of any size.",
          },
          {
            displayName: "Office lunch boxes",
            description: "Individually-packaged halal lunches for office teams.",
          },
          {
            displayName: "Halal shawarma platters",
            description: "Family-style halal shawarma platters served with rice, pita, and sauces.",
          },
        ],
      }),
    }));

    const result = await gmbAIService.generateProfileProposal({
      ...BASE_INPUT,
      businessName: "Shawarma Moose",
      businessType: "Caterer",
      city: "Brampton",
      contextServices: ["Wedding catering", "Office lunch boxes"],
    });

    expect(result.source).toBe("live");
    const displayNames = result.services.map((s) => s.displayName);
    expect(displayNames).not.toContain("Order Delivery");
    expect(displayNames).not.toContain("Pickup");
    expect(displayNames).toContain("Wedding catering");
    expect(displayNames).toContain("Office lunch boxes");
    expect(displayNames).toContain("Halal shawarma platters");
  });

  it("filters generic contextServices in the fallback path", async () => {
    cacheFindUniqueMock.mockImplementationOnce(async () => null);
    llmInvokeMock.mockImplementation(async () => {
      throw new Error("OpenAI 500");
    });

    const result = await gmbAIService.generateProfileProposal({
      ...BASE_INPUT,
      businessName: "Shawarma Moose",
      businessType: "Caterer",
      city: "Brampton",
      // Mix of generics and real services — the fallback path historically
      // echoed all of these back verbatim; the filter must strip generics.
      contextServices: [
        "Order Delivery",
        "Pickup",
        "Wedding catering",
        "Gift Cards",
        "Office lunch boxes",
      ],
    });

    expect(result.source).toBe("fallback");
    const displayNames = result.services.map((s) => s.displayName);
    expect(displayNames).not.toContain("Order Delivery");
    expect(displayNames).not.toContain("Pickup");
    expect(displayNames).not.toContain("Gift Cards");
    expect(displayNames).toContain("Wedding catering");
    expect(displayNames).toContain("Office lunch boxes");
  });

  it("cleans mid-word truncation from an LLM description that still passes Zod", async () => {
    // The LLM returned exactly the safe limit (720 chars) but the sentence
    // was cut mid-word at "centr". Zod accepts (≤720) but the renderer
    // would have shown "...Dietary needs are centr". The fit pass must back
    // up to the last complete sentence.
    cacheFindUniqueMock.mockImplementationOnce(async () => null);

    const intro =
      "Shawarma Moose is a Toronto-based fast-casual shawarma and Turkish/Mediterranean spot known for the best shawarma in town. ";
    const body =
      "The menu features authentic Middle Eastern staples crafted with fresh ingredients. Guests can dine in, grab a quick bite, or order online for pickup or delivery. Shawarma Moose focuses on Mediterranean and Greek catering for offices and events across Toronto and the GTA. They offer flexible formats including individually packaged meal boxes, buffet-style trays, and sandwich platters making it easy to feed teams at scale. ";
    const tail = "Dietary needs are centr";
    // Pad/cut to exactly the safe limit so Zod accepts.
    const description = (intro + body + tail).slice(0, 720);

    llmInvokeMock.mockImplementationOnce(async () => ({
      content: JSON.stringify({
        description,
        categories: ["Caterer", "Halal restaurant"],
        services: [
          {
            displayName: "Wedding catering",
            description: "Hand-carved shawarma platters for weddings.",
          },
          {
            displayName: "Office lunch boxes",
            description: "Individually packaged halal lunches for offices.",
          },
          {
            displayName: "Halal platters",
            description: "Family-style halal platters with rice, pita, and sauces.",
          },
        ],
      }),
    }));

    const result = await gmbAIService.generateProfileProposal({
      ...BASE_INPUT,
      businessName: "Shawarma Moose",
      businessType: "Caterer",
      city: "Toronto",
    });

    expect(result.source).toBe("live");
    expect(result.description).not.toMatch(/centr$/);
    expect(result.description).toMatch(/[.!?]$/);
    expect(result.description.length).toBeLessThanOrEqual(720);
  });
});

// Helper: compute the same hash the service uses, so the test can assert
// equality without re-implementing the field order.
async function computeExpectedHash(
  input: typeof BASE_INPUT & { topDiscoveryKeywords?: string[] },
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const fields = [
    input.businessName ?? "",
    input.businessType ?? "",
    input.description ?? "",
    input.targetAudience ?? "",
    input.city ?? "",
    input.state ?? "",
    input.country ?? "",
    input.websiteUrl ?? "",
    input.contextServices.join(""),
  ];
  fields.push((input.topDiscoveryKeywords ?? []).join(","));
  return createHash("sha256").update(fields.join("")).digest("hex");
}
