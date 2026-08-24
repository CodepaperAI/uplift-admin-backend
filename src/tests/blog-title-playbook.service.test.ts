import { describe, expect, it } from "bun:test";
import {
  allocateBlogTitlePlaybookStrategies,
  buildBlogTitlePlaybookFallback,
  buildBlogTitlePlaybookPrompt,
  evaluateBlogTopicSerpOwnership,
  buildBlogTopicSerpRefinement,
  getBlogTopicStructureFailures,
  getBlogTitlePlaybookFailures,
  selectBlogTitlePlaybookStrategy,
  titleSimilarityScore,
  type BlogTitlePlaybookArchetype,
} from "../services/blog-title-playbook.service";

describe("Blog Topic Playbook title strategy", () => {
  const classificationCases: ReadonlyArray<
    readonly [string, BlogTitlePlaybookArchetype]
  > = [
    ["roof replacement cost Toronto", "cost-pricing"],
    ["AC blowing warm air", "symptom-diagnosis"],
    ["tank vs tankless", "comparison"],
    ["how long does a roof last", "lifespan-timing"],
    ["can I replace a faucet myself", "diy-vs-pro"],
    ["winter furnace checklist Ontario", "local-seasonal"],
    ["what happens during a roof replacement", "process-expectation"],
    ["roofing quote red flags", "mistakes-red-flags"],
    ["how to unclog a kitchen drain", "how-to"],
    ["top 7 plumbing companies Toronto", "best-of-listicle"],
    ["extended stay hotel benefits", "best-of-listicle"],
    ["alternatives to Example Plumbing", "competitor-comparison"],
    ["what is a SEER rating", "glossary-definition"],
  ];

  for (const [keyword, expected] of classificationCases) {
    it(`maps ${keyword} to ${expected}`, () => {
      expect(selectBlogTitlePlaybookStrategy({ keyword }).archetype).toBe(
        expected,
      );
    });
  }

  it("keeps benefit-led keywords in a benefits list instead of rotating to red flags", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "extended stay hotel benefits",
      variationSeed:
        "Homestay Inn & Suites|extended stay hotel benefits|2026-07-31",
      preferredVariationFamily: "question",
    });

    expect(strategy.archetype).toBe("best-of-listicle");
    expect(strategy.variationFamily).toBe("question");
    expect(strategy.topicDirective).toContain("substantive items");
    const fallback = buildBlogTitlePlaybookFallback({
      keyword: "extended stay hotel benefits",
      strategy,
    });
    expect(fallback).toBe(
      "Which Extended Stay Hotel Benefits Are Worth Considering?",
    );
    expect(getBlogTitlePlaybookFailures(fallback, strategy)).toEqual([]);
  });

  it("adds an options noun to singular best-of question fallbacks", () => {
    const strategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "kadian maintenance therapy",
        preferredVariationFamily: "question",
      }),
      archetype: "best-of-listicle" as const,
      variationFamily: "question" as const,
    };
    const fallback = buildBlogTitlePlaybookFallback({
      keyword: "kadian maintenance therapy",
      strategy,
    });
    expect(fallback).toBe(
      "Which Kadian Maintenance Therapy Options Are Worth Considering?",
    );
    expect(getBlogTitlePlaybookFailures(fallback, strategy)).toEqual([]);
  });

  it("keeps a trailing location in a plain how-to fallback", () => {
    const strategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "buy and sell Canada",
      }),
      archetype: "how-to" as const,
      variationFamily: "plain" as const,
    };
    const fallback = buildBlogTitlePlaybookFallback({
      keyword: "buy and sell Canada",
      strategy,
    });

    expect(fallback).toBe(
      "A Step-by-Step Approach to Buy and Sell in Canada",
    );
    expect(getBlogTitlePlaybookFailures(fallback, strategy)).toEqual([]);
  });

  it("uses first-party and case-study formats only when the evidence exists", () => {
    expect(
      selectBlogTitlePlaybookStrategy({
        keyword: "average furnace repair failures",
        allowedClaims: [
          "We analyzed 200 completed repair calls from January to March.",
        ],
      }).archetype,
    ).toBe("first-party-data");
    expect(
      selectBlogTitlePlaybookStrategy({
        keyword: "average furnace repair failures",
      }).archetype,
    ).not.toBe("first-party-data");
    expect(
      selectBlogTitlePlaybookStrategy({
        keyword: "case study kitchen renovation",
        allowedClaims: ["Completed project cost and project date"],
      }).archetype,
    ).toBe("case-study");
    expect(
      selectBlogTitlePlaybookStrategy({
        keyword: "case study kitchen renovation",
      }).archetype,
    ).not.toBe("case-study");
  });

  it("turns the selected archetype into an auditable prompt contract", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "roof repair cost Toronto",
      variationSeed: "plan-123",
    });
    const prompt = buildBlogTitlePlaybookPrompt(strategy);
    expect(prompt).toContain("Cost and pricing transparency");
    expect(prompt).toContain("Preferred variation for this article");
    expect(prompt).toContain("Never invent a year, price, statistic");
    expect(prompt).toContain("A Practical Guide");
  });

  it("treats red flags as an occasional phrase instead of a writing template", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "roofing quote red flags",
      variationSeed: "professional-tone",
    });
    const prompt = buildBlogTitlePlaybookPrompt(strategy);

    expect(strategy.label).toBe("Mistakes and decision checks");
    expect(strategy.topicDirective).toContain("Name each concern precisely");
    expect(strategy.topicDirective).toContain("occasional emphasis");
    expect(prompt).toContain("calm, credible professional");
    expect(prompt).toContain("never as the repeated prefix");
  });

  it("rejects generic guide formulas and titles that drift from a strong intent", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "roof repair cost Toronto",
    });
    expect(
      getBlogTitlePlaybookFailures(
        "A Practical Guide to Roof Repair Cost Toronto",
        strategy,
      ),
    ).toContain("generic_guide_formula");
    expect(
      getBlogTitlePlaybookFailures(
        "Roof Repair in Toronto: Materials and Colours",
        strategy,
      ),
    ).toContain("title_does_not_match_cost-pricing");
    expect(
      getBlogTitlePlaybookFailures(
        "How Much Does Roof Repair Cost in Toronto?",
        { ...strategy, variationFamily: "question" },
      ),
    ).toEqual([]);
  });

  it("builds a non-generic fallback and detects close repetitions", () => {
    const strategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "roofing quote red flags",
      }),
      variationFamily: "plain" as const,
    };
    const fallback = buildBlogTitlePlaybookFallback({
      keyword: "roofing quote red flags",
      strategy,
    });
    expect(fallback).toBe(
      "Roofing Quote Red Flags to Check Before You Decide",
    );
    expect(fallback).not.toMatch(/Practical Guide|Complete Guide/i);
    expect(
      titleSimilarityScore(
        "Roofing Quote Red Flags: Questions to Ask",
        "Roofing Quote Red Flags: Questions You Should Ask",
      ),
    ).toBeGreaterThan(0.8);
  });

  it("rotates title grammar deterministically instead of forcing one template", () => {
    const families = new Set(
      ["plan-a", "plan-b", "plan-c", "plan-d", "plan-e", "plan-f"].map(
        (variationSeed) =>
          selectBlogTitlePlaybookStrategy({
            keyword: "roof replacement cost Toronto",
            variationSeed,
          }).variationFamily,
      ),
    );
    expect(families.size).toBeGreaterThan(1);
  });

  it("honours a valid batch-assigned family without weakening keyword intent", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "roof replacement cost Toronto",
      variationSeed: "independent-seed",
      preferredVariationFamily: "colon",
    });
    expect(strategy.archetype).toBe("cost-pricing");
    expect(strategy.variationFamily).toBe("colon");

    const listicle = selectBlogTitlePlaybookStrategy({
      keyword: "living room painting ideas",
      preferredVariationFamily: "question",
    });
    expect(listicle.archetype).toBe("best-of-listicle");
    expect(listicle.variationFamily).toBe("question");
    expect(listicle.substantiveItemCount).toBe(7);
  });

  it("allocates title families across a business sequence and the batch", () => {
    const allocations = allocateBlogTitlePlaybookStrategies({
      items: Array.from({ length: 12 }, (_, index) => ({
        id: `plan-${String(index).padStart(2, "0")}`,
        businessId: index < 6 ? "business-a" : "business-b",
        publishDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
        keyword: `roof replacement cost area ${index + 1}`,
        variationSeed: `plan-${index}`,
      })),
      recentFamiliesByBusiness: {
        "business-a": ["question", "question"],
        "business-b": ["colon"],
      },
    });
    for (const businessId of ["business-a", "business-b"]) {
      const families = allocations
        .filter((allocation) => allocation.businessId === businessId)
        .map((allocation) => allocation.strategy.variationFamily);
      expect(
        families.some((family, index) => index > 0 && family === families[index - 1]),
      ).toBe(false);
    }
    const questionCount = allocations.filter(
      (allocation) => allocation.strategy.variationFamily === "question",
    ).length;
    expect(questionCount).toBeLessThanOrEqual(4);
  });

  it("keeps an editorial list contract without forcing another consecutive numbered title", () => {
    const [allocation] = allocateBlogTitlePlaybookStrategies({
      items: [
        {
          id: "virus-plan",
          businessId: "repair-business",
          publishDate: "2026-08-03",
          keyword: "computer virus removal tips",
          variationSeed: "virus-plan",
        },
      ],
      recentFamiliesByBusiness: {
        "repair-business": ["plain", "colon", "numbered"],
      },
    });

    expect(allocation!.strategy.substantiveItemCount).toBe(7);
    expect(allocation!.candidateFamilies).toEqual([
      "numbered",
      "question",
      "plain",
      "comparison",
    ]);
    expect(allocation!.strategy.variationFamily).not.toBe("numbered");
  });

  it("rotates broad seeds across topic archetypes instead of defaulting to process", () => {
    const fallbacks = new Set(
      Array.from({ length: 30 }, (_, index) => {
        const strategy = selectBlogTitlePlaybookStrategy({
          keyword: "commercial real estate",
          variationSeed: `plan-${index}`,
        });
        return buildBlogTitlePlaybookFallback({
          keyword: "commercial real estate",
          strategy,
        });
      }),
    );
    expect(fallbacks.size).toBeGreaterThan(2);
    expect([...fallbacks]).toContain(
      "Understanding Commercial Real Estate",
    );
    expect([...fallbacks]).toContain(
      "Commercial Real Estate Options Worth Comparing",
    );
    expect([...fallbacks].some((title) => /What to Expect/i.test(title))).toBe(
      false,
    );
  });

  it("rejects headlines that ignore the selected variation family", () => {
    const base = selectBlogTitlePlaybookStrategy({
      keyword: "best mulch for landscaping beds",
    });
    expect(
      getBlogTitlePlaybookFailures(
        "7 best mulch for landscaping beds, compared using durability",
        { ...base, variationFamily: "plain" },
      ),
    ).toContain("title_violates_plain_variation");
    expect(
      getBlogTitlePlaybookFailures(
        "Choosing the Best Mulch for Landscaping Beds",
        { ...base, variationFamily: "plain" },
      ),
    ).not.toContain("title_violates_plain_variation");
  });

  it("builds a natural plain fallback for best-of keywords", () => {
    const strategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "best mulch for landscaping beds",
      }),
      variationFamily: "plain" as const,
    };
    expect(
      buildBlogTitlePlaybookFallback({
        keyword: "best mulch for landscaping beds",
        strategy,
      }),
    ).toBe("Choosing the Best Mulch for Landscaping Beds");
  });

  it("rejects literal playbook scaffolding and treats idea keywords as substantive lists", () => {
    const strategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "living room painting ideas",
      }),
      variationFamily: "numbered" as const,
    };
    expect(
      getBlogTitlePlaybookFailures(
        "Living room painting ideas from first step to next decision",
        strategy,
      ),
    ).toContain("generic_playbook_title_shape");
    expect(
      buildBlogTitlePlaybookFallback({
        keyword: "living room painting ideas",
        strategy,
      }),
    ).toBe("7 Living Room Painting Ideas");
  });

  it("keeps natural question titles and rejects statement-shaped questions", () => {
    const strategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "how to get leads from Instagram organically",
      }),
      variationFamily: "question" as const,
    };
    expect(
      getBlogTitlePlaybookFailures(
        "How to Get Leads From Instagram Organically?",
        strategy,
      ),
    ).toEqual([]);
    expect(
      getBlogTitlePlaybookFailures(
        "Questions to Ask Before Getting Instagram Leads?",
        strategy,
      ),
    ).toContain("title_question_is_not_natural_interrogative");
    const virusStrategy = {
      ...selectBlogTitlePlaybookStrategy({
        keyword: "computer virus removal tips",
      }),
      variationFamily: "question" as const,
    };
    expect(
      getBlogTitlePlaybookFailures(
        "What are safe computer virus removal tips?",
        virusStrategy,
      ),
    ).toContain("title_question_has_awkward_word_order");
    expect(
      buildBlogTitlePlaybookFallback({
        keyword: "computer virus removal tips",
        strategy: virusStrategy,
      }),
    ).toBe("Which Computer Virus Removal Tips Are Safe to Try?");
  });

  it("uses natural glossary fallbacks instead of a repeated hardcoded formula", () => {
    const base = selectBlogTitlePlaybookStrategy({
      keyword: "what is risk management",
    });
    expect(
      buildBlogTitlePlaybookFallback({
        keyword: "what is risk management",
        strategy: { ...base, variationFamily: "question" },
      }),
    ).toBe("What Is Risk Management?");
    expect(
      getBlogTitlePlaybookFailures(
        "Risk Management: Definition, Use, and Key Questions",
        { ...base, variationFamily: "colon" },
      ),
    ).toContain("generic_playbook_title_shape");
  });

  it("keeps a location-bearing glossary keyword intact", () => {
    const keyword = "International Student Insurance Canada";
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword,
      variationSeed: `${keyword}|recovery`,
    });
    const title = buildBlogTitlePlaybookFallback({ keyword, strategy });

    expect(title).toContain("International Student Insurance");
    expect(title).toContain("Canada");
    expect(getBlogTitlePlaybookFailures(title, strategy)).toEqual([]);
  });

  it("selects article topics from the playbook instead of defaulting broad recovery seeds to process posts", () => {
    const cases: ReadonlyArray<
      readonly [string, BlogTitlePlaybookArchetype]
    > = [
      ["toronto maple cabinet refinishing tips", "best-of-listicle"],
      ["Chicken wings Ottawa", "best-of-listicle"],
      ["home renovations Moncton", "mistakes-red-flags"],
      ["hotels with family suites", "best-of-listicle"],
      ["commercial cleaning Halifax", "mistakes-red-flags"],
      ["buy chocolates online", "best-of-listicle"],
      ["device diagnostics basics", "glossary-definition"],
      ["indian food menu", "best-of-listicle"],
      ["shower tile installation", "how-to"],
      ["spray coating equipment", "comparison"],
    ];

    for (const [keyword, expected] of cases) {
      const strategy = selectBlogTitlePlaybookStrategy({
        keyword,
        variationSeed: `batch-10|${keyword}`,
      });
      expect(strategy.archetype).toBe(expected);
      expect(strategy.archetype).not.toBe("process-expectation");
      expect(strategy.topicDirective).toBeTruthy();
    }
  });

  it("treats an editorial list count as an article contract, not an invented fact", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "toronto maple cabinet refinishing tips",
      variationSeed: "batch-10|paint2decor",
      preferredVariationFamily: "numbered",
    });
    expect(strategy.variationFamily).toBe("numbered");
    expect(strategy.substantiveItemCount).toBe(7);
    expect(
      getBlogTopicStructureFailures(
        "7 Toronto Maple Cabinet Refinishing Tips",
        [
          "<h1>7 Toronto Maple Cabinet Refinishing Tips</h1>",
          ...Array.from(
            { length: 7 },
            (_, index) => `<h2>${index + 1}. Tip</h2><p>Detail.</p>`,
          ),
        ].join(""),
        strategy,
      ),
    ).toEqual([]);
    expect(
      getBlogTopicStructureFailures(
        "Toronto Maple Cabinet Refinishing Tips",
        "<h1>Toronto Maple Cabinet Refinishing Tips</h1><h2>Tips</h2>",
        strategy,
      ),
    ).toEqual([
      "title_missing_required_item_count:7",
      "article_missing_required_item_count:7",
    ]);
  });

  it("keeps a plain recovery title compatible with an editorial list contract", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "bangles buying guide Surrey decision checklist",
      variationSeed: "recovery-plan",
      preferredVariationFamily: "plain",
    });

    expect(strategy.archetype).toBe("best-of-listicle");
    expect(strategy.substantiveItemCount).toBe(7);
    expect(strategy.variationFamily).toBe("plain");
    const title = buildBlogTitlePlaybookFallback({
        keyword: "bangles buying guide Surrey",
        strategy,
      });
    expect(title).toBe(
      "Bangles Buying Guide Options Worth Comparing in Surrey",
    );
    expect(
      getBlogTopicStructureFailures(
        title,
        `<h1>${title}</h1><ol>${Array.from(
          { length: 7 },
          (_, index) => `<li>Decision ${index + 1}</li>`,
        ).join("")}</ol>`,
        strategy,
      ),
    ).toEqual([]);
  });

  it("flags transactional seeds for SERP ownership validation", () => {
    const strategy = selectBlogTitlePlaybookStrategy({
      keyword: "buy chocolates online",
    });
    expect(strategy.sourceIntent).toBe("transactional-or-service");
    expect(strategy.requiresSerpValidation).toBe(true);
  });

  it("builds natural numbered topic fallbacks instead of prefixing 7 to a raw query", () => {
    const examples: ReadonlyArray<readonly [string, string]> = [
      [
        "buy chocolates online",
        "7 Things to Check Before You Buy Chocolates Online",
      ],
      [
        "indian food menu",
        "7 Dishes to Explore on an Indian Food Menu",
      ],
      [
        "Chicken wings Ottawa",
        "7 Ways to Choose Chicken Wings in Ottawa",
      ],
      [
        "home renovations Moncton",
        "7 Home Renovation Mistakes to Avoid in Moncton",
      ],
    ];
    for (const [keyword, expected] of examples) {
      const strategy = selectBlogTitlePlaybookStrategy({
        keyword,
        preferredVariationFamily: "numbered",
      });
      expect(
        buildBlogTitlePlaybookFallback({ keyword, strategy }),
      ).toBe(expected);
    }
  });

  it("uses live result page types to separate blog topics from money-page queries", () => {
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          { title: "Order Online", url: "https://example.com/menu" },
          { title: "Chicken Wings", url: "https://example.org/order" },
          { title: "View Menu", url: "https://example.net/menu/wings" },
        ],
      }).decision,
    ).toBe("money-page-owned");

    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          { title: "How to choose a personal trainer", url: "https://one.example/blog/choose", structure: "article" },
          { title: "How to find the right trainer", url: "https://two.example/articles/find", structure: "how-to" },
          { title: "Trainer comparison", url: "https://three.example/guides/compare", structure: "guide" },
          { title: "Book a trainer", url: "https://four.example/booking", structure: "service" },
          { title: "Personal training", url: "https://five.example/services/training", structure: "service" },
          { title: "Find a trainer", url: "https://six.example/", structure: "service" },
        ],
      }).decision,
    ).toBe("blog-owned");
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "list",
        top10Results: [
          { title: "7 Tips", url: "https://example.com/blog/tips" },
          { title: "Ideas", url: "https://example.org/articles/ideas" },
          { title: "Checklist", url: "https://example.net/learn/checklist" },
        ],
      }).decision,
    ).toBe("blog-owned");
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          { title: "Family suite", url: "https://hotel.example.com/booking", structure: "service" },
          { title: "Connecting rooms", url: "https://stay.example.com/rooms", structure: "service" },
          { title: "Book a suite", url: "https://inn.example.com/book", structure: "service" },
          { title: "Family hotel tips", url: "https://example.com/blog/family-hotels", structure: "article" },
          { title: "Suite checklist", url: "https://example.org/articles/suite-checklist", structure: "list" },
          { title: "Travel guide", url: "https://example.net/learn/family-travel", structure: "guide" },
          { title: "Room ideas", url: "https://travel.example.com/blog/room-ideas", structure: "article" },
          { title: "Family stay guide", url: "https://guide.example.com/articles/family-stays", structure: "article" },
        ],
      }).decision,
    ).toBe("blog-owned");
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "mixed",
        top10Results: [{ title: "One result", url: "https://example.com" }],
      }).decision,
    ).toBe("insufficient-evidence");

    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "mixed",
        top10Results: [
          {
            title: "In-Home Personal Trainer Toronto | Santé Active",
            url: "https://www.santeactive.ca/en/personal-trainer-toronto-gta",
            structure: "article",
          },
          {
            title: "Personal Trainer North York - Triat Fitness",
            url: "https://triatfitness.ca/",
            structure: "article",
          },
          {
            title: "Private Personal Trainer Toronto",
            url: "https://pureflowfitness.ca/in-person-training",
            structure: "article",
          },
        ],
      }).decision,
    ).toBe("money-page-owned");

    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "list",
        top10Results: [
          { title: "Best Personal Trainer Toronto", url: "https://trainer-one.example/", structure: "list" },
          { title: "Top Personal Training in the GTA", url: "https://trainer-two.example/personal-training", structure: "list" },
          { title: "Personal Trainer Comparison Guide", url: "https://trainer-three.example/coaching", structure: "guide" },
        ],
      }).decision,
    ).toBe("money-page-owned");
  });

  it("treats international government guidance trees as informational", () => {
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          {
            title: "Choosing a home loan",
            url: "https://moneysmart.gov.au/home-loans/choosing-a-home-loan",
            structure: "service",
          },
          {
            title: "Using a mortgage broker",
            url: "https://moneysmart.gov.au/home-loans/using-a-mortgage-broker",
            structure: "service",
          },
          {
            title: "Switching home loans",
            url: "https://moneysmart.gov.au/home-loans/switching-home-loans",
            structure: "service",
          },
        ],
      }).decision,
    ).toBe("blog-owned");
  });

  it("normalizes informational shallow paths without opening true commercial pages", () => {
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          {
            title: "How to Choose the Best Daycare for Your Child",
            url: "https://daycare.example/daycare-selection-guide",
            structure: "service",
          },
          {
            title: "How Do I Find and Choose Quality Child Care?",
            url: "https://childcare.example/consumer-education/find-quality-care",
            structure: "service",
          },
          {
            title: "Uplighting at Your Wedding: Your Expert Guide",
            url: "https://weddings.example/content/wedding-uplighting",
            structure: "service",
          },
          {
            title: "Wedding Lighting: What Every Decision Affects",
            url: "https://blog.weddings.example/what-lighting-decisions-affect",
            structure: "service",
          },
          {
            title: "DIY Wedding Uplights Rental",
            url: "https://rentals.example/rentals/uplighting/diy-uplights",
            structure: "article",
          },
          {
            title: "Personal Trainer Comparison Guide",
            url: "https://trainer.example/coaching",
            structure: "guide",
          },
        ],
      }).decision,
    ).toBe("blog-owned");
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          {
            title: "Personal Trainer Comparison Guide",
            url: "https://trainer.example/coaching",
            structure: "guide",
          },
          {
            title: "Top Personal Training in the GTA",
            url: "https://fitness.example/personal-training",
            structure: "list",
          },
          {
            title: "DIY Wedding Uplights Rental",
            url: "https://rentals.example/rentals/uplighting/diy-uplights",
            structure: "article",
          },
        ],
      }).decision,
    ).toBe("money-page-owned");
  });

  it("treats official government service trees as informational guidance", () => {
    expect(
      evaluateBlogTopicSerpOwnership({
        dominantFormat: "service",
        top10Results: [
          {
            title: "Personal income tax",
            url: "https://www.canada.ca/en/services/taxes/income-tax/personal-income-tax.html",
            structure: "service",
          },
          {
            title: "Get ready to file a tax return",
            url: "https://www.canada.ca/en/services/taxes/income-tax/personal-income-tax/get-ready-taxes.html",
            structure: "service",
          },
          {
            title: "Completing a basic tax return",
            url: "https://www.canada.ca/en/revenue-agency/services/tax/individuals/educational-programs/completing-basic-return.html",
            structure: "service",
          },
        ],
      }).decision,
    ).toBe("blog-owned");
  });

  it("refines money-page seeds into informational article topics", () => {
    const equipment = selectBlogTitlePlaybookStrategy({
      keyword: "spray coating equipment",
    });
    expect(
      buildBlogTopicSerpRefinement({
        keyword: "spray coating equipment",
        strategy: equipment,
      }),
    ).toBe("how to choose spray coating equipment");

    const cleaning = selectBlogTitlePlaybookStrategy({
      keyword: "commercial cleaning Halifax",
    });
    expect(
      buildBlogTopicSerpRefinement({
        keyword: "commercial cleaning Halifax",
        strategy: cleaning,
        location: "Halifax",
      }),
    ).toBe(
      "questions to ask before hiring a commercial cleaning company in Halifax",
    );
  });
});
