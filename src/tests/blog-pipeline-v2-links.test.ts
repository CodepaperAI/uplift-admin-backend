import { describe, expect, test } from "bun:test";

import { filterProductionLinkCandidates } from "../services/blog-pipeline-v2/link-selector";

describe("production-v2 contextual link selection", () => {
  test("drops generic blog/home candidates while retaining a relevant internal page", () => {
    const filtered = filterProductionLinkCandidates({
      businessId: "business-1",
      websiteUrl: "https://www.example.com/",
      keyword: "online driving theory",
      candidates: [
        {
          kind: "internal",
          title: "blog",
          url: "https://example.com/blog",
          businessId: "business-1",
          score: 0.23,
        },
        {
          kind: "internal",
          title: "Online driving theory course",
          url: "https://www.example.com/driving-theory",
          businessId: "business-1",
          score: 0.48,
        },
        {
          kind: "internal",
          title: "example.com",
          url: "https://example.com/",
          businessId: "business-1",
          score: 0.9,
        },
      ],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.url).toBe("https://example.com/driving-theory");
  });

  test("keeps only sufficiently relevant managed candidates from another business", () => {
    const filtered = filterProductionLinkCandidates({
      businessId: "business-1",
      websiteUrl: "https://example.com/",
      keyword: "garden drainage planning",
      candidates: [
        {
          kind: "managed_backlink",
          title: "Garden drainage planning",
          url: "https://partner.example/drainage",
          businessId: "business-2",
          score: 0.72,
        },
        {
          kind: "managed_backlink",
          title: "Unrelated company page",
          url: "https://other.example/",
          businessId: "business-3",
          score: 0.4,
        },
      ],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.kind).toBe("managed_backlink");
  });
});
