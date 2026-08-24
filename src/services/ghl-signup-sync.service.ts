type SignupUser = {
  businessName?: string | null;
  businessWebsite?: string | null;
  country?: string | null;
  countryCode?: string | null;
  id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  createdAt?: Date | string | null;
};

type GhlSyncResult =
  | { status: "skipped"; reason: string }
  | {
      status: "synced";
      contactId?: string;
      opportunity?: GhlOpportunitySyncResult;
    }
  | { status: "failed"; reason: string };

type GhlOpportunitySyncResult =
  | { status: "skipped"; reason: string; existingOpportunityId?: string }
  | { status: "created"; opportunityId?: string }
  | { status: "failed"; reason: string };

type GhlSignupPayloadPreview =
  | { status: "skipped"; reason: string }
  | {
      status: "ready";
      endpoint: string;
      hasApiToken: boolean;
      opportunity?: GhlOpportunityPayloadPreview;
      payload: Record<string, unknown>;
      version: string;
    };

type GhlOpportunityPayloadPreview =
  | { status: "skipped"; reason: string }
  | {
      status: "ready";
      endpoint: string;
      payload: Record<string, unknown>;
    };

type GhlCustomField = {
  id?: string;
  key?: string;
  field_value: string;
};

type GhlOpportunityRoute = {
  assignedTo?: string;
  pipelineStageId: string;
  status: string;
};

type GhlOpportunityDuplicateCheckResult =
  | { status: "found"; opportunityId?: string }
  | { status: "not-found" }
  | { status: "failed"; reason: string };

const DEFAULT_GHL_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_GHL_VERSION = "2021-07-28";
const DEFAULT_GHL_SOURCE = "Uplift auto signup";
const DEFAULT_GHL_SIGNUP_TAGS = [
  "uplift-signup",
  "uplift-free-signup",
  "uplift-nurture",
];
const DEFAULT_TRIAL_DAYS = 7;
const INDIAN_COUNTRY_CODES = new Set(["IN", "IND"]);
const INDIAN_COUNTRY_TERMS = [
  "india",
  "bharat",
  "gujarat",
  "haryana",
  "kolkata",
  "maharashtra",
  "uttar pradesh",
  "delhi",
  "mumbai",
  "bangalore",
  "bengaluru",
  "hyderabad",
  "chennai",
  "punjab",
  "rajasthan",
  "kerala",
  "karnataka",
  "tamil nadu",
];

function cleanEnv(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "";
}

function splitName(name?: string | null) {
  const parts = cleanEnv(name).split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }

  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

function parseTags(value?: string | null) {
  const configured = cleanEnv(value)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  return Array.from(new Set([...DEFAULT_GHL_SIGNUP_TAGS, ...configured]));
}

function parseStaticCustomFields(value?: string | null): GhlCustomField[] {
  const raw = cleanEnv(value);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((field) => {
      if (!field || typeof field !== "object") return [];
      const record = field as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const key = typeof record.key === "string" ? record.key.trim() : "";
      const rawValue =
        typeof record.field_value === "string"
          ? record.field_value
          : typeof record.value === "string"
            ? record.value
            : "";
      const field_value = rawValue.trim();

      if ((!id && !key) || !field_value) return [];
      return [{ ...(id ? { id } : { key }), field_value }];
    });
  } catch {
    return [];
  }
}

function parseSignupDate(value?: Date | string | null) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseTrialDays() {
  const parsed = Number.parseInt(cleanEnv(process.env.GHL_SIGNUP_TRIAL_DAYS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRIAL_DAYS;
}

function parseOptionalNumber(value?: string | null) {
  const cleaned = cleanEnv(value);
  if (!cleaned) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLookupText(value?: string | null) {
  return cleanEnv(value).toLowerCase();
}

function phoneDigits(phone?: string | null) {
  return cleanEnv(phone).replace(/\D/g, "");
}

function isIndianPhone(phone?: string | null) {
  const raw = cleanEnv(phone);
  const digits = phoneDigits(raw);
  if (!digits) return false;

  if (raw.startsWith("+91") || raw.startsWith("0091")) return true;
  return digits.startsWith("91") && digits.length === 12;
}

function isIndianDomain(value?: string | null) {
  const raw = cleanEnv(value).toLowerCase();
  if (!raw) return false;

  const candidate = raw.includes("://") ? raw : `https://${raw}`;

  try {
    return new URL(candidate).hostname.endsWith(".in");
  } catch {
    const host = raw.replace(/^https?:\/\//, "").split("/")[0] || "";
    return host.endsWith(".in");
  }
}

function isIndianSignup(user: SignupUser) {
  const countryCode = cleanEnv(user.countryCode).toUpperCase();
  const country = normalizeLookupText(user.country);
  const emailDomain = cleanEnv(user.email).split("@")[1] || "";

  if (INDIAN_COUNTRY_CODES.has(countryCode)) return true;
  if (INDIAN_COUNTRY_TERMS.some((term) => country.includes(term))) return true;
  if (isIndianPhone(user.phone)) return true;
  if (isIndianDomain(user.businessWebsite)) return true;
  if (isIndianDomain(emailDomain)) return true;

  return false;
}

function resolveOpportunityRoute(user: SignupUser): GhlOpportunityRoute {
  if (isIndianSignup(user)) {
    return {
      assignedTo: cleanEnv(process.env.GHL_SIGNUP_INDIAN_ASSIGNED_TO_USER_ID),
      pipelineStageId:
        cleanEnv(process.env.GHL_SIGNUP_INDIAN_OPPORTUNITY_STAGE_ID) ||
        cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STAGE_ID) ||
        cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID),
      status:
        cleanEnv(process.env.GHL_SIGNUP_INDIAN_OPPORTUNITY_STATUS) ||
        cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STATUS) ||
        "lost",
    };
  }

  return {
    assignedTo: cleanEnv(process.env.GHL_SIGNUP_ASSIGNED_TO_USER_ID),
    pipelineStageId: cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID),
    status: cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_STATUS) || "open",
  };
}

function isDuplicateCheckEnabled() {
  return process.env.GHL_SIGNUP_OPPORTUNITY_DUPLICATE_CHECK_ENABLED !== "false";
}

function buildPlaceholderValues(user: SignupUser) {
  const signupDate = parseSignupDate(user.createdAt);
  const trialStartDate = signupDate;
  const trialEndDate = addDays(trialStartDate, parseTrialDays());
  const { firstName, lastName } = splitName(user.name);
  const email = cleanEnv(user.email).toLowerCase();
  const name = cleanEnv(user.name) || email;

  return {
    business_name: cleanEnv(user.businessName),
    business_website: cleanEnv(user.businessWebsite),
    country: cleanEnv(user.country),
    country_code: cleanEnv(user.countryCode).toUpperCase(),
    email,
    first_name: firstName,
    last_name: lastName,
    name,
    phone: cleanEnv(user.phone),
    signup_date: formatDate(signupDate),
    trial_end_date: formatDate(trialEndDate),
    trial_start_date: formatDate(trialStartDate),
    uplift_user_id: cleanEnv(user.id),
  };
}

function resolveTemplate(value: string, placeholders: Record<string, string>) {
  return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    return placeholders[key] ?? match;
  });
}

function upsertCustomField(fields: GhlCustomField[], field: GhlCustomField) {
  const identity = field.id ? `id:${field.id}` : field.key ? `key:${field.key}` : "";
  if (!identity) return fields;

  const existingIndex = fields.findIndex((item) => {
    const itemIdentity = item.id ? `id:${item.id}` : item.key ? `key:${item.key}` : "";
    return itemIdentity === identity;
  });

  if (existingIndex >= 0) {
    fields[existingIndex] = field;
    return fields;
  }

  fields.push(field);
  return fields;
}

function buildCustomFields(user: SignupUser): GhlCustomField[] {
  const placeholders = buildPlaceholderValues(user);
  const fields = parseStaticCustomFields(process.env.GHL_SIGNUP_CUSTOM_FIELDS_JSON).map(
    (field) => ({
      ...field,
      field_value: resolveTemplate(field.field_value, placeholders),
    }),
  );
  const userIdField = cleanEnv(process.env.GHL_SIGNUP_USER_ID_FIELD_ID);

  if (userIdField && user.id) {
    upsertCustomField(fields, { id: userIdField, field_value: user.id });
  }

  return fields;
}

export function isGhlSignupSyncConfigured() {
  return Boolean(
    cleanEnv(process.env.GHL_API_TOKEN) && cleanEnv(process.env.GHL_LOCATION_ID),
  );
}

export function buildGhlSignupPayloadPreview(user: SignupUser): GhlSignupPayloadPreview {
  if (process.env.GHL_SIGNUP_SYNC_ENABLED === "false") {
    return { status: "skipped", reason: "disabled" };
  }

  const token = cleanEnv(process.env.GHL_API_TOKEN);
  const locationId = cleanEnv(process.env.GHL_LOCATION_ID);
  const email = cleanEnv(user.email).toLowerCase();

  if (!locationId) {
    return { status: "skipped", reason: "missing-config" };
  }

  if (!email) {
    return { status: "skipped", reason: "missing-email" };
  }

  const baseUrl =
    cleanEnv(process.env.GHL_API_BASE_URL) || DEFAULT_GHL_BASE_URL;
  const version =
    cleanEnv(process.env.GHL_API_VERSION) || DEFAULT_GHL_VERSION;
  const name = cleanEnv(user.name) || email;
  const { firstName, lastName } = splitName(user.name);
  const tags = parseTags(process.env.GHL_SIGNUP_TAGS);
  const customFields = buildCustomFields(user);
  const route = resolveOpportunityRoute(user);

  const payload: Record<string, unknown> = {
    locationId,
    email,
    name,
    source: cleanEnv(process.env.GHL_SIGNUP_SOURCE) || DEFAULT_GHL_SOURCE,
  };

  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  if (cleanEnv(user.phone)) payload.phone = cleanEnv(user.phone);
  if (cleanEnv(user.businessName)) payload.companyName = cleanEnv(user.businessName);
  if (cleanEnv(user.businessWebsite)) payload.website = cleanEnv(user.businessWebsite);
  if (tags.length > 0) payload.tags = tags;
  if (customFields.length > 0) payload.customFields = customFields;
  if (route.assignedTo) payload.assignedTo = route.assignedTo;

  const opportunity = buildGhlOpportunityPayloadPreview({
    baseUrl,
    contactId: cleanEnv(process.env.GHL_PREVIEW_CONTACT_ID) || "preview-contact-123",
    locationId,
    user,
  });

  return {
    status: "ready",
    endpoint: `${baseUrl.replace(/\/$/, "")}/contacts/upsert`,
    hasApiToken: Boolean(token),
    ...(process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED === "true"
      ? { opportunity }
      : {}),
    payload,
    version,
  };
}

function buildGhlOpportunityPayloadPreview(input: {
  baseUrl: string;
  contactId?: string | null;
  locationId: string;
  user: SignupUser;
}): GhlOpportunityPayloadPreview {
  if (process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED !== "true") {
    return { status: "skipped", reason: "disabled" };
  }

  const pipelineId = cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID);
  const route = resolveOpportunityRoute(input.user);
  const pipelineStageId = route.pipelineStageId;
  const contactId = cleanEnv(input.contactId);

  if (!pipelineId || !pipelineStageId) {
    return { status: "skipped", reason: "missing-opportunity-config" };
  }

  if (!contactId) {
    return { status: "skipped", reason: "missing-contact-id" };
  }

  const placeholders = buildPlaceholderValues(input.user);
  const opportunityNameTemplate =
    cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE) ||
    "{{name}} - Uplift signup";
  const monetaryValue = parseOptionalNumber(
    process.env.GHL_SIGNUP_OPPORTUNITY_MONETARY_VALUE,
  );
  const payload: Record<string, unknown> = {
    contactId,
    locationId: input.locationId,
    name: resolveTemplate(opportunityNameTemplate, placeholders),
    pipelineId,
    pipelineStageId,
    source:
      cleanEnv(process.env.GHL_SIGNUP_OPPORTUNITY_SOURCE) ||
      cleanEnv(process.env.GHL_SIGNUP_SOURCE) ||
      DEFAULT_GHL_SOURCE,
    status: route.status,
  };

  if (monetaryValue !== null) {
    payload.monetaryValue = monetaryValue;
  }
  if (route.assignedTo) {
    payload.assignedTo = route.assignedTo;
  }

  return {
    status: "ready",
    endpoint: `${input.baseUrl.replace(/\/$/, "")}/opportunities/`,
    payload,
  };
}

function buildOpportunitySearchEndpoint(input: {
  baseUrl: string;
  contactId: string;
  locationId: string;
  pipelineId: string;
}) {
  const endpoint = new URL(`${input.baseUrl.replace(/\/$/, "")}/opportunities/search`);
  endpoint.searchParams.set("location_id", input.locationId);
  endpoint.searchParams.set("contact_id", input.contactId);
  endpoint.searchParams.set("pipeline_id", input.pipelineId);
  return endpoint.toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findOpportunityRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOpportunityRecord(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;

  const directOpportunity = findOpportunityRecord(record.opportunity, depth + 1);
  if (directOpportunity) return directOpportunity;

  for (const key of ["opportunities", "items", "data", "results"]) {
    const found = findOpportunityRecord(record[key], depth + 1);
    if (found) return found;
  }

  return typeof record.id === "string" ? record : null;
}

async function findExistingSignupOpportunity(input: {
  baseUrl: string;
  contactId: string;
  locationId: string;
  pipelineId: string;
  token: string;
  version: string;
}): Promise<GhlOpportunityDuplicateCheckResult> {
  if (!isDuplicateCheckEnabled()) {
    return { status: "not-found" };
  }

  try {
    const response = await fetch(buildOpportunitySearchEndpoint(input), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Version: input.version,
      },
    });

    const responseBody = (await response.json().catch(() => null)) as
      | { message?: string; error?: string }
      | unknown;

    if (!response.ok) {
      const record = asRecord(responseBody);
      return {
        status: "failed",
        reason:
          (typeof record?.message === "string" && record.message) ||
          (typeof record?.error === "string" && record.error) ||
          `GHL opportunity duplicate check failed (${response.status})`,
      };
    }

    const opportunity = findOpportunityRecord(responseBody);
    if (!opportunity) {
      return { status: "not-found" };
    }

    return {
      status: "found",
      opportunityId:
        typeof opportunity.id === "string" ? opportunity.id : undefined,
    };
  } catch (error) {
    return {
      status: "failed",
      reason:
        error instanceof Error
          ? error.message
          : "Unknown GHL opportunity duplicate check error",
    };
  }
}

async function syncSignupOpportunityToGhl(input: {
  contactId?: string | null;
  token: string;
  user: SignupUser;
  version: string;
}): Promise<GhlOpportunitySyncResult> {
  const signupPreview = buildGhlSignupPayloadPreview(input.user);
  if (signupPreview.status !== "ready") {
    return { status: "skipped", reason: "signup-not-ready" };
  }

  const opportunityPreview = buildGhlOpportunityPayloadPreview({
    baseUrl:
      cleanEnv(process.env.GHL_API_BASE_URL) || DEFAULT_GHL_BASE_URL,
    contactId: input.contactId,
    locationId: String(signupPreview.payload.locationId || ""),
    user: input.user,
  });

  if (opportunityPreview.status === "skipped") {
    return opportunityPreview;
  }

  try {
    const payload = opportunityPreview.payload;
    const baseUrl =
      cleanEnv(process.env.GHL_API_BASE_URL) || DEFAULT_GHL_BASE_URL;
    const duplicateCheck = await findExistingSignupOpportunity({
      baseUrl,
      contactId: String(payload.contactId || ""),
      locationId: String(payload.locationId || ""),
      pipelineId: String(payload.pipelineId || ""),
      token: input.token,
      version: input.version,
    });

    if (duplicateCheck.status === "found") {
      return {
        status: "skipped",
        reason: "duplicate-opportunity",
        existingOpportunityId: duplicateCheck.opportunityId,
      };
    }

    if (duplicateCheck.status === "failed") {
      return { status: "failed", reason: duplicateCheck.reason };
    }

    const response = await fetch(opportunityPreview.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        Version: input.version,
      },
      body: JSON.stringify(opportunityPreview.payload),
    });

    const responseBody = (await response.json().catch(() => null)) as
      | {
          opportunity?: { id?: string };
          id?: string;
          message?: string;
          error?: string;
        }
      | null;

    if (!response.ok) {
      return {
        status: "failed",
        reason:
          responseBody?.message ||
          responseBody?.error ||
          `GHL opportunity request failed (${response.status})`,
      };
    }

    return {
      status: "created",
      opportunityId: responseBody?.opportunity?.id || responseBody?.id,
    };
  } catch (error) {
    return {
      status: "failed",
      reason:
        error instanceof Error
          ? error.message
          : "Unknown GHL opportunity sync error",
    };
  }
}

export async function syncSignupToGhl(user: SignupUser): Promise<GhlSyncResult> {
  const preview = buildGhlSignupPayloadPreview(user);

  if (preview.status === "skipped") {
    return preview;
  }

  const token = cleanEnv(process.env.GHL_API_TOKEN);
  if (!token) {
    return { status: "skipped", reason: "missing-config" };
  }

  try {
    const response = await fetch(preview.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: preview.version,
      },
      body: JSON.stringify(preview.payload),
    });

    const responseBody = (await response.json().catch(() => null)) as
      | { contact?: { id?: string }; message?: string; error?: string }
      | null;

    if (!response.ok) {
      return {
        status: "failed",
        reason:
          responseBody?.message ||
          responseBody?.error ||
          `GHL request failed (${response.status})`,
      };
    }

    const contactId = responseBody?.contact?.id;
    const opportunity = await syncSignupOpportunityToGhl({
      contactId,
      token,
      user,
      version: preview.version,
    });

    return {
      status: "synced",
      contactId,
      ...(opportunity.status !== "skipped" ||
      opportunity.reason === "duplicate-opportunity"
        ? { opportunity }
        : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "Unknown GHL sync error",
    };
  }
}
