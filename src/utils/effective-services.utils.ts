import { filterOutGenericServices } from "./generic-services.utils";

type CoreServicesShape = {
  topLevel?: string[] | null;
  subOfferings?: string[] | null;
  industryFocus?: string[] | null;
};

type EffectiveServicesInput = {
  selectedServices?: string[] | null;
  servicesPriority?: unknown;
  detectedServices?: unknown;
  websiteAnalysis?: {
    coreServices?: CoreServicesShape | null;
  } | null;
  coreServices?: CoreServicesShape | null;
};

export type EffectiveServices = {
  topLevel: string[];
  subOfferings: string[];
  industryFocus: string[];
  orderedPrimaryServices: string[];
};

function normalizeServiceName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeServiceKey(value: string): string {
  return normalizeServiceName(value).toLowerCase();
}

function normalizeStringArray(values?: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const deduped = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const cleaned = normalizeServiceName(value);
    if (!cleaned) {
      continue;
    }

    const key = normalizeServiceKey(cleaned);
    if (deduped.has(key)) {
      continue;
    }

    deduped.add(key);
    normalized.push(cleaned);
  }

  return normalized;
}

export function buildServicesPriorityFromOrder(
  services: string[],
): Record<string, number> {
  return services.reduce<Record<string, number>>((acc, service, index) => {
    const cleaned = normalizeServiceName(service);
    if (!cleaned) {
      return acc;
    }

    acc[cleaned] = index + 1;
    return acc;
  }, {});
}

export function resolveServicesPriorityMap(
  servicesPriority?: unknown,
): Record<string, number> {
  if (!servicesPriority || typeof servicesPriority !== "object" || Array.isArray(servicesPriority)) {
    return {};
  }

  const priorityEntries = Object.entries(
    servicesPriority as Record<string, unknown>,
  );

  return priorityEntries.reduce<Record<string, number>>((acc, [service, value]) => {
    const cleaned = normalizeServiceName(service);
    if (!cleaned || typeof value !== "number" || !Number.isFinite(value)) {
      return acc;
    }

    acc[cleaned] = value;
    return acc;
  }, {});
}

export function resolveOrderedSelectedServices(
  selectedServices?: unknown,
  servicesPriority?: unknown,
): string[] {
  const normalizedSelectedServices = normalizeStringArray(selectedServices);
  const priorityMap = resolveServicesPriorityMap(servicesPriority);

  return normalizedSelectedServices
    .map((service, index) => ({
      service,
      index,
      priority: priorityMap[service] ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.index - right.index;
    })
    .map(({ service }) => service);
}

export function resolveEffectiveServices(
  input: EffectiveServicesInput,
): EffectiveServices {
  // selectedServices is user-curated; trust it as-is. Scraped sources go
  // through the generic-services filter to strip e-commerce mechanics
  // ("Order Delivery", "Pickup", "Gift Cards") that pollute downstream GMB
  // suggestions when websites built on Shopify/Wix themes are scraped.
  const selectedServices = normalizeStringArray(input.selectedServices);
  const detectedServices = filterOutGenericServices(
    normalizeStringArray(input.detectedServices),
  );
  const scrapedCoreServices =
    input.websiteAnalysis?.coreServices ?? input.coreServices ?? null;
  const scrapedTopLevel = filterOutGenericServices(
    normalizeStringArray(scrapedCoreServices?.topLevel),
  );
  const scrapedSubOfferings = filterOutGenericServices(
    normalizeStringArray(scrapedCoreServices?.subOfferings),
  );
  const scrapedIndustryFocus = filterOutGenericServices(
    normalizeStringArray(scrapedCoreServices?.industryFocus),
  );
  const orderedSelectedServices = resolveOrderedSelectedServices(
    selectedServices,
    input.servicesPriority,
  );
  const orderedPrimaryServices = normalizeStringArray([
    ...orderedSelectedServices,
    ...scrapedTopLevel,
    ...detectedServices,
  ]);
  const primaryKeys = new Set(
    orderedPrimaryServices.map((service) => normalizeServiceKey(service)),
  );
  const subOfferings = scrapedSubOfferings.filter(
    (service) => !primaryKeys.has(normalizeServiceKey(service)),
  );
  const secondaryKeys = new Set(
    [...orderedPrimaryServices, ...subOfferings].map((service) =>
      normalizeServiceKey(service),
    ),
  );
  const industryFocus = scrapedIndustryFocus.filter(
    (service) => !secondaryKeys.has(normalizeServiceKey(service)),
  );

  return {
    topLevel: orderedPrimaryServices,
    subOfferings,
    industryFocus,
    orderedPrimaryServices,
  };
}
