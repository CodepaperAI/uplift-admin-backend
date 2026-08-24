import { describe, expect, test } from "bun:test";

import {
  researchLocationForContext,
  resolveProductionPublicationLocale,
} from "../services/blog-pipeline-v2/context-loader";

describe("production pipeline language and research locale", () => {
  test("preserves French Canadian language and location", () => {
    expect(
      resolveProductionPublicationLocale({
        id: "business-1",
        defaultLocale: "fr-FR",
        defaultLanguage: "fr",
        businessCountry: "Canada",
      }),
    ).toBe("fr-CA");
    expect(
      researchLocationForContext({
        locale: "fr-CA",
        country: "Canada",
        region: "Québec",
        city: "Montréal",
      }),
    ).toEqual({
      locationCode: 2124,
      languageCode: "fr",
      country: "Canada",
      region: "Québec",
      city: "Montréal",
    });
  });

  test("preserves Italian and uses the Italian research market", () => {
    expect(
      resolveProductionPublicationLocale({
        id: "business-2",
        defaultLocale: "it-IT",
        defaultLanguage: "it",
        businessCountry: "Italy",
      }),
    ).toBe("it-IT");
    const result = researchLocationForContext({
      locale: "it-IT",
      country: "Italy",
      region: "Lombardy",
      city: "Milan",
    });
    expect(result.languageCode).toBe("it");
    expect(result.locationCode).toBe(2380);
  });
});
