import {
  normalizeAddressCountryCode,
  parseGeoapifyAddressSuggestions,
  parseGooglePlacesAddressSuggestions,
  type AddressSuggestion,
} from "../utils/address-autocomplete";

const PROVIDER_TIMEOUT_MS = 5_000;
const GOOGLE_FIELD_MASK = [
  "places.id",
  "places.formattedAddress",
  "places.addressComponents",
].join(",");

export type AddressAutocompleteResult = {
  available: boolean;
  provider: "geoapify" | "google" | null;
  suggestions: AddressSuggestion[];
};

function unavailable(
  provider: AddressAutocompleteResult["provider"],
): AddressAutocompleteResult {
  return { available: false, provider, suggestions: [] };
}

function providerConfiguration(): {
  apiKey: string;
  provider: "geoapify" | "google";
} | null {
  const geoapifyKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (geoapifyKey) return { apiKey: geoapifyKey, provider: "geoapify" };
  const googleKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (googleKey) return { apiKey: googleKey, provider: "google" };
  return null;
}

function geoapifyRequest(query: string, countryCode: string | null, apiKey: string) {
  const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
  url.searchParams.set("text", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("lang", "en");
  url.searchParams.set("limit", "6");
  url.searchParams.set("apiKey", apiKey);
  if (countryCode) url.searchParams.set("filter", `countrycode:${countryCode}`);
  return { input: url, init: { headers: { Accept: "application/json" } } };
}

function googleRequest(query: string, countryCode: string | null, apiKey: string) {
  const body: Record<string, unknown> = {
    languageCode: "en",
    maxResultCount: 6,
    textQuery: query,
  };
  if (countryCode) body.regionCode = countryCode.toUpperCase();
  return {
    input: new URL("https://places.googleapis.com/v1/places:searchText"),
    init: {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
      },
      method: "POST",
    },
  };
}

export async function autocompleteAddress(input: {
  country?: string;
  query: string;
}): Promise<AddressAutocompleteResult> {
  const configuration = providerConfiguration();
  if (!configuration) return unavailable(null);

  const { apiKey, provider } = configuration;
  const countryCode = normalizeAddressCountryCode(input.country);
  const request =
    provider === "geoapify"
      ? geoapifyRequest(input.query, countryCode, apiKey)
      : googleRequest(input.query, countryCode, apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(request.input, {
      ...request.init,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("Address provider request failed", {
        provider,
        status: response.status,
      });
      return unavailable(provider);
    }
    const payload = (await response.json()) as unknown;
    const suggestions =
      provider === "geoapify"
        ? parseGeoapifyAddressSuggestions(payload)
        : parseGooglePlacesAddressSuggestions(payload);
    return { available: true, provider, suggestions };
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") {
      console.error("Address provider request error", {
        message: error.message,
        provider,
      });
    }
    return unavailable(provider);
  } finally {
    clearTimeout(timeout);
  }
}
