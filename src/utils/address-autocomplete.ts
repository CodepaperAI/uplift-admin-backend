export type AddressSuggestion = {
  addressLine1: string;
  city: string;
  country: string;
  countryCode: string;
  id: string;
  label: string;
  postcode: string;
  state: string;
};

type GeoapifyResult = {
  address_line1?: unknown;
  city?: unknown;
  country?: unknown;
  country_code?: unknown;
  formatted?: unknown;
  housenumber?: unknown;
  place_id?: unknown;
  postcode?: unknown;
  state?: unknown;
  street?: unknown;
  suburb?: unknown;
  town?: unknown;
  village?: unknown;
};

type GoogleAddressComponent = {
  longText?: unknown;
  shortText?: unknown;
  types?: unknown;
};

type GooglePlace = {
  addressComponents?: unknown;
  formattedAddress?: unknown;
  id?: unknown;
};

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  australia: "au",
  canada: "ca",
  india: "in",
  "united kingdom": "gb",
  "united states": "us",
  "united states of america": "us",
};

const MAX_PROVIDER_RESULTS = 6;
const MAX_ADDRESS_FIELD_LENGTH = 300;

function stringValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_ADDRESS_FIELD_LENGTH);
}

export function normalizeAddressCountryCode(value?: string): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (/^[a-z]{2}$/.test(normalized)) return normalized;
  return COUNTRY_NAME_TO_CODE[normalized] ?? null;
}

export function parseGeoapifyAddressSuggestions(
  payload: unknown,
): AddressSuggestion[] {
  const results =
    payload && typeof payload === "object" && "results" in payload
      ? (payload as { results?: unknown }).results
      : null;
  if (!Array.isArray(results)) return [];

  const seen = new Set<string>();
  const suggestions: AddressSuggestion[] = [];
  for (const candidate of results) {
    if (!candidate || typeof candidate !== "object") continue;
    const result = candidate as GeoapifyResult;
    const addressLine1 =
      stringValue(result.address_line1) ||
      [stringValue(result.housenumber), stringValue(result.street)]
        .filter(Boolean)
        .join(" ");
    const label = stringValue(result.formatted) || addressLine1;
    const id = stringValue(result.place_id) || label.toLowerCase();
    if (!addressLine1 || !label || seen.has(id)) continue;
    seen.add(id);

    const countryCode = stringValue(result.country_code).toUpperCase();
    suggestions.push({
      addressLine1,
      city:
        stringValue(result.city) ||
        stringValue(result.town) ||
        stringValue(result.village) ||
        stringValue(result.suburb),
      country: stringValue(result.country),
      countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "",
      id,
      label,
      postcode: stringValue(result.postcode),
      state: stringValue(result.state),
    });
    if (suggestions.length >= MAX_PROVIDER_RESULTS) break;
  }
  return suggestions;
}

function googleAddressComponent(
  components: GoogleAddressComponent[],
  types: string[],
  useShortText = false,
): string {
  const component = components.find((candidate) => {
    const candidateTypes = Array.isArray(candidate.types)
      ? candidate.types.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return types.some((type) => candidateTypes.includes(type));
  });
  return stringValue(useShortText ? component?.shortText : component?.longText);
}

export function parseGooglePlacesAddressSuggestions(
  payload: unknown,
): AddressSuggestion[] {
  const places =
    payload && typeof payload === "object" && "places" in payload
      ? (payload as { places?: unknown }).places
      : null;
  if (!Array.isArray(places)) return [];

  const seen = new Set<string>();
  const suggestions: AddressSuggestion[] = [];
  for (const candidate of places) {
    if (!candidate || typeof candidate !== "object") continue;
    const place = candidate as GooglePlace;
    const components = Array.isArray(place.addressComponents)
      ? place.addressComponents.filter(
          (value): value is GoogleAddressComponent =>
            Boolean(value) && typeof value === "object" && !Array.isArray(value),
        )
      : [];
    const streetNumber = googleAddressComponent(components, ["street_number"]);
    const route = googleAddressComponent(components, ["route"]);
    const premise = googleAddressComponent(components, ["premise"]);
    const subpremise = googleAddressComponent(components, ["subpremise"]);
    const addressLine1 =
      [streetNumber, route].filter(Boolean).join(" ") ||
      [premise, subpremise].filter(Boolean).join(" ");
    const label = stringValue(place.formattedAddress) || addressLine1;
    const id = stringValue(place.id) || label.toLowerCase();
    if (!addressLine1 || !label || seen.has(id)) continue;
    seen.add(id);

    const countryCode = googleAddressComponent(
      components,
      ["country"],
      true,
    ).toUpperCase();
    suggestions.push({
      addressLine1,
      city: googleAddressComponent(components, [
        "locality",
        "postal_town",
        "sublocality_level_1",
        "administrative_area_level_2",
      ]),
      country: googleAddressComponent(components, ["country"]),
      countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "",
      id,
      label,
      postcode: googleAddressComponent(components, ["postal_code"]),
      state: googleAddressComponent(components, [
        "administrative_area_level_1",
      ]),
    });
    if (suggestions.length >= MAX_PROVIDER_RESULTS) break;
  }
  return suggestions;
}
