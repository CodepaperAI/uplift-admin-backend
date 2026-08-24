import { describe, expect, it } from "bun:test";
import {
  createGetWebsiteDataToolWithCache,
  extractOnboardingFailureResultFromText,
  ONBOARDING_LLM_FAILURE_PREFIX,
} from "../tools/llm.tools";

describe("get-website-info tool", () => {
  it("always uses the canonical website URL from runtime context and ignores caller-supplied extras", async () => {
    const tool = createGetWebsiteDataToolWithCache(
      {
        websiteUrl: "https://canonical.example",
      },
      new Map([
        [
          "https://canonical.example/",
          {
            normalizedUrl: "https://canonical.example/",
            finalUrl: "https://canonical.example/",
            markdown: "# Canonical Example\n\nGrounded content",
            markdownMode: "markdown" as const,
            renderFallbackReason: null,
            structuredFallbackUsed: false,
            puppeteerFallbackUsed: false,
            seoSignals: {
              title: "Canonical Example",
            },
          },
        ],
      ]),
    );

    const result = (await tool.invoke({
      chunk: null,
      url: "https://evil.example",
    } as never)) as string;

    const parsed = JSON.parse(result);
    expect(parsed.diagnostics.canonicalUrl).toBe("https://canonical.example/");
    expect(parsed.currentChunk).toBe(1);
    expect(parsed.content.markdown).toContain("Canonical Example");
  });

  it("returns a terminal failure payload when the canonical website URL is invalid", async () => {
    const tool = createGetWebsiteDataToolWithCache(
      {
        websiteUrl: "",
      },
      new Map(),
    );

    const result = (await tool.invoke({ chunk: null })) as string;

    expect(result.startsWith(ONBOARDING_LLM_FAILURE_PREFIX)).toBe(true);
    expect(extractOnboardingFailureResultFromText(result)).toMatchObject({
      code: "site_inaccessible",
      stage: "get_website_info",
    });
  });
});
