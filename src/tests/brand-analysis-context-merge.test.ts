import { describe, expect, test } from "bun:test";
import {
  mergeBrandAnalysisSources,
  type BrandData,
} from "../services/brand-analysis.service";
import type { ContextDevBrandProfile } from "../services/context-dev-brand.service";

const websiteBrand: BrandData = {
  primaryColors: ["#111111"],
  secondaryColors: ["#222222"],
  fontFamily: "Inter, sans-serif",
  logoUrl: "https://site.example/logo.png",
  logoAltText: "Site logo",
  faviconUrl: "https://site.example/favicon.ico",
  analysisSource: "website",
};

const contextBrand: ContextDevBrandProfile = {
  schemaVersion: 1,
  provider: "context.dev.brand.retrieve",
  domain: "example.com",
  retrievedAt: "2026-08-09T12:00:00.000Z",
  title: "Example",
  description: null,
  slogan: null,
  primaryColors: ["#6633ff"],
  secondaryColors: ["#f2efff"],
  logoUrl: "https://cdn.example/logo.png",
  logoAltText: "Example",
  faviconUrl: "https://cdn.example/icon.png",
  referenceImageUrl: "https://cdn.example/backdrop.jpg",
  phone: null,
  email: null,
  address: null,
  socials: [],
};

describe("mergeBrandAnalysisSources", () => {
  test("uses Context.dev identity while retaining website typography", () => {
    expect(mergeBrandAnalysisSources(websiteBrand, contextBrand)).toEqual({
      primaryColors: ["#6633ff"],
      secondaryColors: ["#f2efff"],
      fontFamily: "Inter, sans-serif",
      logoUrl: "https://cdn.example/logo.png",
      logoAltText: "Example",
      faviconUrl: "https://cdn.example/icon.png",
      referenceImageUrl: "https://cdn.example/backdrop.jpg",
      analysisSource: "context.dev.brand.retrieve+website",
    });
  });

  test("retains extracted fields when the brand profile is partial or unavailable", () => {
    expect(
      mergeBrandAnalysisSources(websiteBrand, {
        ...contextBrand,
        primaryColors: [],
        secondaryColors: [],
        logoUrl: null,
        logoAltText: null,
        faviconUrl: null,
        referenceImageUrl: null,
      }),
    ).toMatchObject({
      primaryColors: ["#111111"],
      secondaryColors: ["#222222"],
      logoUrl: "https://site.example/logo.png",
      fontFamily: "Inter, sans-serif",
    });
    expect(mergeBrandAnalysisSources(websiteBrand, null)).toEqual(websiteBrand);
  });
});
