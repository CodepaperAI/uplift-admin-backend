import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { autocompleteAddress } from "../services/address-autocomplete.service";
import {
  parseGooglePlacesAddressSuggestions,
} from "../utils/address-autocomplete";

const originalFetch = globalThis.fetch;
const originalGeoapifyKey = process.env.GEOAPIFY_API_KEY;
const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;

describe("backend address autocomplete", () => {
  beforeEach(() => {
    delete process.env.GEOAPIFY_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = "server-only-google-key";
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    process.env.GEOAPIFY_API_KEY = originalGeoapifyKey;
    process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
    globalThis.fetch = originalFetch;
  });

  it("uses the Places API with a field mask and never returns the API key", async () => {
    let providerUrl = "";
    let providerInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      providerUrl = String(input);
      providerInit = init;
      return Response.json({
        places: [
          {
            id: "place-1",
            formattedAddress: "11 Edvac Drive, Brampton, ON, Canada",
            addressComponents: [
              { longText: "11", shortText: "11", types: ["street_number"] },
              { longText: "Edvac Drive", shortText: "Edvac Dr", types: ["route"] },
              { longText: "Brampton", shortText: "Brampton", types: ["locality"] },
              {
                longText: "Ontario",
                shortText: "ON",
                types: ["administrative_area_level_1"],
              },
              { longText: "Canada", shortText: "CA", types: ["country"] },
            ],
          },
        ],
      });
    }) as typeof fetch;

    const result = await autocompleteAddress({
      country: "Canada",
      query: "11 Edvac Drive",
    });

    expect(providerUrl).toBe(
      "https://places.googleapis.com/v1/places:searchText",
    );
    expect(providerInit?.method).toBe("POST");
    expect(new Headers(providerInit?.headers).get("X-Goog-Api-Key")).toBe(
      "server-only-google-key",
    );
    expect(new Headers(providerInit?.headers).get("X-Goog-FieldMask")).toContain(
      "places.addressComponents",
    );
    expect(providerInit?.body).toContain('"regionCode":"CA"');
    expect(result.suggestions[0]?.addressLine1).toBe("11 Edvac Drive");
    expect(JSON.stringify(result)).not.toContain("server-only-google-key");
  });

  it("returns a bounded public contract for malformed provider payloads", () => {
    expect(parseGooglePlacesAddressSuggestions({ places: [{ apiKey: "secret" }] })).toEqual([]);
    expect(parseGooglePlacesAddressSuggestions({ places: "invalid" })).toEqual([]);
  });

  it("degrades provider and configuration failures without leaking responses", async () => {
    globalThis.fetch = (async () =>
      new Response("provider secret response", { status: 403 })) as unknown as typeof fetch;
    const denied = await autocompleteAddress({ query: "11 Edvac Drive" });
    expect(denied).toEqual({
      available: false,
      provider: "google",
      suggestions: [],
    });
    expect(JSON.stringify(denied)).not.toContain("provider secret response");

    delete process.env.GOOGLE_MAPS_API_KEY;
    const unconfigured = await autocompleteAddress({ query: "11 Edvac Drive" });
    expect(unconfigured).toEqual({
      available: false,
      provider: null,
      suggestions: [],
    });
  });
});
