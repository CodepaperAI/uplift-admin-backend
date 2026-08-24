const STREET_HINT =
  /\b(unit|suite|ste|floor|fl|street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|court|ct\.?|lane|ln\.?|highway|hwy|way|place|pl\.?)\b/i;

function cleanText(value?: string | null): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function normalizeCityCandidate(value?: string | null): string | null {
  const text = cleanText(value);
  if (!text) return null;
  if (/^[A-Z]{2,3}$/.test(text)) return null;
  if (/\d/.test(text) && STREET_HINT.test(text)) return null;
  if (text.length > 60) return null;
  return text;
}

export function pickBusinessCity(
  businessCity?: string | null,
  geoLocality?: string | null,
): string | null {
  return normalizeCityCandidate(geoLocality) ?? normalizeCityCandidate(businessCity);
}
