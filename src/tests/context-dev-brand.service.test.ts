import { afterEach, describe, expect, test } from "bun:test";
import type ContextDev from "context.dev";
import {
  retrieveContextDevBrand,
  type ContextDevBrandDependencies,
} from "../services/context-dev-brand.service";

const originalApiKey = process.env.CONTEXT_DEV_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.CONTEXT_DEV_API_KEY;
  else process.env.CONTEXT_DEV_API_KEY = originalApiKey;
});

function testDependencies(
  response: ContextDev.BrandRetrieveResponse,
  onRetrieve?: ContextDevBrandDependencies["retrieve"],
): ContextDevBrandDependencies {
  return {
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    retrieve: onRetrieve ?? (async () => response),
    validateAssetUrl: async (rawUrl) => {
      const url = new URL(rawUrl);
      if (!/^https?:$/.test(url.protocol) || /^(localhost|127\.)/.test(url.hostname)) {
        throw new Error("unsafe asset");
      }
      return url;
    },
  };
}

describe("retrieveContextDevBrand", () => {
  test("returns null without the canonical API key and never calls the provider", async () => {
    delete process.env.CONTEXT_DEV_API_KEY;
    let called = false;
    const result = await retrieveContextDevBrand("https://example.com", {
      retrieve: async () => {
        called = true;
        return { status: "ok", brand: { domain: "example.com" } };
      },
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null for invalid lookup URLs and provider failures", async () => {
    process.env.CONTEXT_DEV_API_KEY = "test-key";
    let calls = 0;
    const retrieve = async () => {
      calls += 1;
      throw new Error("provider unavailable");
    };
    expect(
      await retrieveContextDevBrand("file:///etc/passwd", { retrieve }),
    ).toBeNull();
    expect(calls).toBe(0);
    expect(
      await retrieveContextDevBrand("https://example.com", { retrieve }),
    ).toBeNull();
    expect(calls).toBe(1);
  });

  test("normalizes identity data and selects safe largest preferred assets", async () => {
    process.env.CONTEXT_DEV_API_KEY = "test-key";
    const response: ContextDev.BrandRetrieveResponse = {
      status: "ok",
      code: 200,
      key_metadata: { credits_consumed: 2, credits_remaining: 98 },
      brand: {
        domain: "untrusted-response.example",
        title: "  Example   Brand  ",
        description: "  Practical services   for teams. ",
        slogan: " Work better ",
        colors: [
          { hex: "#ABC" },
          { hex: "#abc" },
          { hex: "rgb(1,2,3)" },
          { hex: "#12345678" },
        ],
        logos: [
          {
            type: "icon",
            url: "https://cdn.example/icon-small.png",
            resolution: { width: 64, height: 64 },
          },
          {
            type: "logo",
            url: "http://127.0.0.1/private.png",
            resolution: { width: 2_000, height: 1_000 },
          },
          {
            type: "logo",
            url: "https://cdn.example/logo-large.png",
            resolution: { width: 1_000, height: 400 },
            colors: [{ hex: "#FEDCBA" }, { hex: "not-a-color" }],
          },
          {
            type: "logo",
            url: "https://cdn.example/logo-small.png",
            resolution: { width: 400, height: 200 },
          },
          {
            type: "icon",
            url: "https://cdn.example/icon-large.png",
            resolution: { width: 128, height: 128 },
          },
        ],
        backdrops: [
          {
            url: "javascript:alert(1)",
            resolution: { width: 5_000, height: 5_000 },
          },
          {
            url: "https://cdn.example/backdrop-large.jpg",
            resolution: { width: 1_920, height: 1_080 },
            colors: [{ hex: "#0f0" }, { hex: "#abc" }],
          },
          {
            url: "https://cdn.example/backdrop-small.jpg",
            resolution: { width: 800, height: 600 },
          },
        ],
        phone: " +1 416 555 0199 ",
        email: " hello@example.com ",
        address: {
          street: "10 King Street",
          city: "Toronto",
          state_province: "Ontario",
          state_code: "ON",
          postal_code: "M5H 1A1",
          country: "Canada",
          country_code: "ca",
        },
        socials: [
          { type: "instagram", url: "https://instagram.com/example" },
          { type: "instagram", url: "https://instagram.com/example" },
          { type: "facebook", url: "javascript:alert(1)" },
        ],
      },
    };

    const profile = await retrieveContextDevBrand(
      "https://www.Example.com/about",
      testDependencies(response),
    );

    expect(profile).toEqual({
      schemaVersion: 1,
      provider: "context.dev.brand.retrieve",
      domain: "example.com",
      retrievedAt: "2026-08-09T12:00:00.000Z",
      title: "Example Brand",
      description: "Practical services for teams.",
      slogan: "Work better",
      primaryColors: ["#abc", "#12345678"],
      secondaryColors: ["#fedcba", "#0f0"],
      logoUrl: "https://cdn.example/logo-large.png",
      logoAltText: "Example Brand",
      faviconUrl: "https://cdn.example/icon-large.png",
      referenceImageUrl: "https://cdn.example/backdrop-large.jpg",
      phone: "+1 416 555 0199",
      email: "hello@example.com",
      address: {
        formatted: "10 King Street, Toronto, Ontario, M5H 1A1, Canada",
        street: "10 King Street",
        city: "Toronto",
        state: "Ontario",
        stateCode: "ON",
        postalCode: "M5H 1A1",
        country: "Canada",
        countryCode: "CA",
      },
      socials: [
        { platform: "instagram", url: "https://instagram.com/example" },
      ],
      usage: { creditsConsumed: 2, creditsRemaining: 98 },
    });
  });

  test("uses a bounded domain retrieval request and ignores unusable responses", async () => {
    process.env.CONTEXT_DEV_API_KEY = "test-key";
    let params: ContextDev.BrandRetrieveParams | undefined;
    let options: ContextDev.RequestOptions | undefined;
    const retrieve: NonNullable<ContextDevBrandDependencies["retrieve"]> = async (
      nextParams,
      nextOptions,
    ) => {
      params = nextParams;
      options = nextOptions;
      return { status: "not_found", code: 404 };
    };

    expect(
      await retrieveContextDevBrand(
        "example.com",
        testDependencies({ status: "not_found" }, retrieve),
      ),
    ).toBeNull();
    expect(params).toEqual({
      domain: "example.com",
      type: "by_domain",
      maxAgeMs: 86_400_000,
      maxSpeed: false,
      tags: ["onboarding-v2", "brand-context"],
      timeoutMS: 10_000,
    });
    expect(options).toEqual({ timeout: 12_000, maxRetries: 1 });
  });

  test("keeps icon-only assets in the favicon field instead of promoting them to a logo", async () => {
    process.env.CONTEXT_DEV_API_KEY = "test-key";
    const profile = await retrieveContextDevBrand(
      "https://example.com",
      testDependencies({
        status: "ok",
        code: 200,
        brand: {
          domain: "example.com",
          title: "Example",
          logos: [
            {
              type: "icon",
              url: "https://cdn.example/icon.png",
              resolution: { width: 256, height: 256 },
            },
          ],
        },
      }),
    );

    expect(profile?.logoUrl).toBeNull();
    expect(profile?.faviconUrl).toBe("https://cdn.example/icon.png");
  });
});
