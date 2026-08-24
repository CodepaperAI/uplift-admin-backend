import { describe, expect, it } from "bun:test";
import {
  createStoreDataInDbTool,
  extractOnboardingFailureResultFromText,
  extractWebsiteAnalysisFromText,
  extractWebsiteAnalysisFromToolCalls,
  extractPersistedBusinessResultFromText,
  normalizeToolWebsiteAnalysisForPersistence,
  ONBOARDING_LLM_FAILURE_PREFIX,
  ONBOARDING_LLM_SUCCESS_PREFIX,
  saveBusinessDataToolSchema,
} from "../tools/llm.tools";

function createStrictToolPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    scrapedUrl: "https://example.com",
    domain: "example.com",
    brandIdentity: {
      name: "Example Co",
      tagline: null,
      platform: null,
      logos: null,
      favicon: null,
    },
    design: null,
    techStack: null,
    coreServices: null,
    recognition: null,
    seo: {
      title: null,
      metaDescription: null,
      canonicalUrl: null,
      keywords: null,
      targetKeywords: null,
      targetKeywordsWithType: null,
      openGraph:
        '{"title":"Example","image":{"url":"https://example.com/image.png"}}',
      twitterCard: '{"card":"summary_large_image"}',
      schema: [
        '{"@context":"https://schema.org","@type":"Organization","name":"Example Co"}',
      ],
      verification: '{"google-site-verification":"abc123"}',
      analytics_tracking: null,
    },
    sitemap: null,
    contactInfo: null,
    socialMedia: null,
    navigation: null,
    competitiveAdvantages: null,
    competitors: null,
    businessInfo: null,
    ...overrides,
  };
}

describe("LLM onboarding persistence result parsing", () => {
  it("extracts the persisted business payload from tool output", () => {
    const result = extractPersistedBusinessResultFromText(
      `${ONBOARDING_LLM_SUCCESS_PREFIX}${JSON.stringify({
        businessId: "biz_123",
        websiteAnalysisId: "wa_123",
        normalizedUrl: "https://example.com",
      })}`,
    );

    expect(result).toEqual({
      businessId: "biz_123",
      websiteAnalysisId: "wa_123",
      normalizedUrl: "https://example.com",
    });
  });

  it("returns null when no success payload is present", () => {
    const result = extractPersistedBusinessResultFromText(
      "No persistence confirmation",
    );

    expect(result).toBeNull();
  });

  it("extracts a structured persistence failure payload from tool output", () => {
    const result = extractOnboardingFailureResultFromText(
      `${ONBOARDING_LLM_FAILURE_PREFIX}${JSON.stringify({
        code: "business_persist_failed",
        stage: "persist_business",
        message: "Failed to persist analyzed business.",
        details: {
          message: "Error in PostgreSQL connection: Error { kind: Closed, cause: None }",
        },
      })}`,
    );

    expect(result).toEqual({
      code: "business_persist_failed",
      stage: "persist_business",
      message: "Failed to persist analyzed business.",
      details: {
        message: "Error in PostgreSQL connection: Error { kind: Closed, cause: None }",
      },
    });
  });

  it("extracts a recoverable website analysis payload from plain JSON text", () => {
    const result = extractWebsiteAnalysisFromText(
      JSON.stringify({
        scrapedUrl: "https://example.com",
        domain: "example.com",
        brandIdentity: {
          name: "Example Co",
        },
      }),
      "user_123",
    );

    expect(result).toEqual({
      scrapedUrl: "https://example.com",
      domain: "example.com",
      userId: "user_123",
      brandIdentity: {
        name: "Example Co",
      },
    });
  });

  it("extracts a recoverable website analysis payload from fenced JSON", () => {
    const result = extractWebsiteAnalysisFromText(
      [
        {
          text: '```json\n{"scrapedUrl":"https://example.com","domain":"example.com","brandIdentity":{"name":"Example Co"}}\n```',
        },
      ],
      "user_456",
    );

    expect(result).toEqual({
      scrapedUrl: "https://example.com",
      domain: "example.com",
      userId: "user_456",
      brandIdentity: {
        name: "Example Co",
      },
    });
  });

  it("normalizes null optional sections before strict website analysis parsing", () => {
    const result = extractWebsiteAnalysisFromText(
      JSON.stringify({
        scrapedUrl: "https://example.com",
        domain: "example.com",
        brandIdentity: {
          name: "Example Co",
          tagline: null,
          logos: null,
        },
        seo: null,
        contactInfo: {
          phone: "123-456-7890",
          bookingUrl: null,
        },
      }),
      "user_nulls",
    );

    expect(result).toEqual({
      scrapedUrl: "https://example.com",
      domain: "example.com",
      userId: "user_nulls",
      brandIdentity: {
        name: "Example Co",
      },
      contactInfo: {
        phone: "123-456-7890",
      },
    });
  });

  it("strips invalid optional contact emails instead of rejecting onboarding analysis", () => {
    const result = normalizeToolWebsiteAnalysisForPersistence(
      createStrictToolPayload({
        contactInfo: {
          phone: "123-456-7890",
          email: "not-an-email",
          contactUrl: null,
          bookingUrl: null,
          locations: null,
          hours: null,
        },
      }),
      "user_invalid_email",
    );

    expect(result.contactInfo).toEqual({
      phone: "123-456-7890",
    });
  });

  it("normalizes mailto contact emails before persistence", () => {
    const result = normalizeToolWebsiteAnalysisForPersistence(
      createStrictToolPayload({
        contactInfo: {
          phone: "123-456-7890",
          email: "mailto:Info@Example.com?subject=Hello",
          contactUrl: null,
          bookingUrl: null,
          locations: null,
          hours: null,
        },
      }),
      "user_mailto_email",
    );

    expect(result.contactInfo?.email).toBe("info@example.com");
  });

  it("normalizes serialized seo metadata into the strict persistence shape", () => {
    const result = extractWebsiteAnalysisFromText(
      JSON.stringify({
        scrapedUrl: "https://example.com",
        domain: "example.com",
        brandIdentity: {
          name: "Example Co",
        },
        seo: {
          openGraph: '{"title":"Example","image":{"url":"https://example.com/image.png"}}',
          twitterCard: '{"card":"summary_large_image"}',
          schema: [
            '{"@context":"https://schema.org","@type":"Organization","name":"Example Co"}',
          ],
          verification: '{"google-site-verification":"abc123"}',
        },
      }),
      "user_seo",
    );

    expect(result).toEqual({
      scrapedUrl: "https://example.com",
      domain: "example.com",
      userId: "user_seo",
      brandIdentity: {
        name: "Example Co",
      },
      seo: {
        openGraph: {
          title: "Example",
          image: '{"url":"https://example.com/image.png"}',
        },
        twitterCard: {
          card: "summary_large_image",
        },
        schema: [
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "Example Co",
          },
        ],
        verification: {
          "google-site-verification": "abc123",
        },
      },
    });
  });

  it("recovers website analysis from save tool call args", () => {
    const result = extractWebsiteAnalysisFromToolCalls(
      [
        {
          name: "get-website-info",
          args: {
            chunk: null,
          },
        },
        {
          name: "save-business-data-to-database",
          args: {
            scrapedUrl: "https://example.com",
            domain: "example.com",
            brandIdentity: {
              name: "Example Co",
            },
            seo: {
              openGraph:
                '{"title":"Example","image":{"url":"https://example.com/image.png"}}',
              twitterCard: '{"card":"summary_large_image"}',
              schema: [
                '{"@context":"https://schema.org","@type":"Organization","name":"Example Co"}',
              ],
              verification: '{"google-site-verification":"abc123"}',
            },
          },
        },
      ],
      "user_tool_call",
    );

    expect(result).toEqual({
      scrapedUrl: "https://example.com",
      domain: "example.com",
      userId: "user_tool_call",
      brandIdentity: {
        name: "Example Co",
      },
      seo: {
        openGraph: {
          title: "Example",
          image: '{"url":"https://example.com/image.png"}',
        },
        twitterCard: {
          card: "summary_large_image",
        },
        schema: [
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "Example Co",
          },
        ],
        verification: {
          "google-site-verification": "abc123",
        },
      },
    });
  });

  it("normalizes validated save tool input for persistence without reapplying the raw tool schema", () => {
    const rawToolInput = createStrictToolPayload();

    expect(() => saveBusinessDataToolSchema.parse(rawToolInput)).not.toThrow();

    const normalized = normalizeToolWebsiteAnalysisForPersistence(
      {
        ...rawToolInput,
        userId: "user_tool_schema",
      },
      "user_tool_schema",
    );

    expect(normalized).toEqual({
      scrapedUrl: "https://example.com",
      domain: "example.com",
      userId: "user_tool_schema",
      brandIdentity: {
        name: "Example Co",
      },
      seo: {
        openGraph: {
          title: "Example",
          image: '{"url":"https://example.com/image.png"}',
        },
        twitterCard: {
          card: "summary_large_image",
        },
        schema: [
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            name: "Example Co",
          },
        ],
        verification: {
          "google-site-verification": "abc123",
        },
      },
    });
  });

  it("returns a non-retryable failure marker when normalized data fails WEBSITE_ANALYSIS validation", async () => {
    const toolResponse = await createStoreDataInDbTool({
      userId: "user_invalid",
      websiteUrl: "https://example.com",
    }).invoke(
      createStrictToolPayload({
        scrapedUrl: "not-a-url",
      }),
    );

    const failure = extractOnboardingFailureResultFromText(toolResponse);

    expect(failure).toEqual({
      code: "analysis_validation_failed",
      stage: "website_analysis_validation",
      message:
        "Normalized onboarding save payload failed WEBSITE_ANALYSIS validation.",
      details: expect.any(Object),
    });
  });

  it("returns null when the JSON is not a website analysis payload", () => {
    const result = extractWebsiteAnalysisFromText(
      '{"businessId":"biz_123"}',
      "user_789",
    );

    expect(result).toBeNull();
  });
});
