import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildGhlSignupPayloadPreview,
  syncSignupToGhl,
} from "../services/ghl-signup-sync.service";

const ORIGINAL_ENV = {
  GHL_API_BASE_URL: process.env.GHL_API_BASE_URL,
  GHL_API_TOKEN: process.env.GHL_API_TOKEN,
  GHL_API_VERSION: process.env.GHL_API_VERSION,
  GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
  GHL_SIGNUP_CUSTOM_FIELDS_JSON: process.env.GHL_SIGNUP_CUSTOM_FIELDS_JSON,
  GHL_SIGNUP_SOURCE: process.env.GHL_SIGNUP_SOURCE,
  GHL_SIGNUP_SYNC_ENABLED: process.env.GHL_SIGNUP_SYNC_ENABLED,
  GHL_SIGNUP_TAGS: process.env.GHL_SIGNUP_TAGS,
  GHL_SIGNUP_TRIAL_DAYS: process.env.GHL_SIGNUP_TRIAL_DAYS,
  GHL_SIGNUP_USER_ID_FIELD_ID: process.env.GHL_SIGNUP_USER_ID_FIELD_ID,
  GHL_SIGNUP_ASSIGNED_TO_USER_ID: process.env.GHL_SIGNUP_ASSIGNED_TO_USER_ID,
  GHL_SIGNUP_OPPORTUNITY_MONETARY_VALUE:
    process.env.GHL_SIGNUP_OPPORTUNITY_MONETARY_VALUE,
  GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE:
    process.env.GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE,
  GHL_SIGNUP_OPPORTUNITY_DUPLICATE_CHECK_ENABLED:
    process.env.GHL_SIGNUP_OPPORTUNITY_DUPLICATE_CHECK_ENABLED,
  GHL_SIGNUP_OPPORTUNITY_LOST_STAGE_ID:
    process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STAGE_ID,
  GHL_SIGNUP_OPPORTUNITY_LOST_STATUS:
    process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STATUS,
  GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID:
    process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID,
  GHL_SIGNUP_OPPORTUNITY_SOURCE: process.env.GHL_SIGNUP_OPPORTUNITY_SOURCE,
  GHL_SIGNUP_OPPORTUNITY_STAGE_ID:
    process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID,
  GHL_SIGNUP_OPPORTUNITY_STATUS: process.env.GHL_SIGNUP_OPPORTUNITY_STATUS,
  GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED:
    process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED,
  GHL_SIGNUP_INDIAN_OPPORTUNITY_STAGE_ID:
    process.env.GHL_SIGNUP_INDIAN_OPPORTUNITY_STAGE_ID,
  GHL_SIGNUP_INDIAN_OPPORTUNITY_STATUS:
    process.env.GHL_SIGNUP_INDIAN_OPPORTUNITY_STATUS,
  GHL_SIGNUP_INDIAN_ASSIGNED_TO_USER_ID:
    process.env.GHL_SIGNUP_INDIAN_ASSIGNED_TO_USER_ID,
};

const originalFetch = globalThis.fetch;

function clearOpportunityEnv() {
  delete process.env.GHL_SIGNUP_OPPORTUNITY_MONETARY_VALUE;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_DUPLICATE_CHECK_ENABLED;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STAGE_ID;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STATUS;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_SOURCE;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_STATUS;
  delete process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED;
  delete process.env.GHL_SIGNUP_ASSIGNED_TO_USER_ID;
  delete process.env.GHL_SIGNUP_INDIAN_OPPORTUNITY_STAGE_ID;
  delete process.env.GHL_SIGNUP_INDIAN_OPPORTUNITY_STATUS;
  delete process.env.GHL_SIGNUP_INDIAN_ASSIGNED_TO_USER_ID;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  clearOpportunityEnv();
});

afterEach(() => {
  restoreEnv();
  globalThis.fetch = originalFetch;
});

describe("GHL signup sync", () => {
  it("previews the signup payload without requiring or exposing an API token", () => {
    delete process.env.GHL_API_TOKEN;
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_SOURCE = "Uplift preview";
    process.env.GHL_SIGNUP_TAGS = "trial";
    process.env.GHL_SIGNUP_USER_ID_FIELD_ID = "custom-user-id";
    process.env.GHL_SIGNUP_CUSTOM_FIELDS_JSON =
      '[{"id":"trial-end","field_value":"{{trial_end_date}}"}]';

    const preview = buildGhlSignupPayloadPreview({
      businessName: "Preview Co",
      businessWebsite: "https://preview.example.com",
      id: "user-1",
      email: "Preview@Example.com",
      name: "Preview User",
      phone: "+14165550123",
      createdAt: "2026-06-10T15:30:00.000Z",
    });

    expect(preview).toEqual({
      status: "ready",
      endpoint: "https://services.example.test/contacts/upsert",
      hasApiToken: false,
      version: "2021-07-28",
      payload: {
        locationId: "location-123",
        email: "preview@example.com",
        name: "Preview User",
        source: "Uplift preview",
        firstName: "Preview",
        lastName: "User",
        phone: "+14165550123",
        companyName: "Preview Co",
        website: "https://preview.example.com",
        tags: [
          "uplift-signup",
          "uplift-free-signup",
          "uplift-nurture",
          "trial",
        ],
        customFields: [
          { id: "trial-end", field_value: "2026-06-17" },
          { id: "custom-user-id", field_value: "user-1" },
        ],
      },
    });
  });

  it("skips when config is missing", async () => {
    delete process.env.GHL_API_TOKEN;
    delete process.env.GHL_LOCATION_ID;

    const result = await syncSignupToGhl({
      id: "user-1",
      email: "new@example.com",
      name: "New User",
    });

    expect(result).toEqual({ status: "skipped", reason: "missing-config" });
  });

  it("upserts a new signup into GHL", async () => {
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_SOURCE = "Uplift signup";
    process.env.GHL_SIGNUP_TAGS = "uplift-signup, trial";
    delete process.env.GHL_SIGNUP_CUSTOM_FIELDS_JSON;
    process.env.GHL_SIGNUP_USER_ID_FIELD_ID = "custom-user-id";

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ contact: { id: "contact-123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      businessName: "New Co",
      businessWebsite: "https://new.example.com",
      id: "user-1",
      email: "New@Example.com",
      name: "New User",
      phone: "+14165550123",
    });

    expect(result).toEqual({ status: "synced", contactId: "contact-123" });
    expect(capturedUrl).toBe("https://services.example.test/contacts/upsert");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      Authorization: "Bearer ghl-token",
      "Content-Type": "application/json",
      Version: "2021-07-28",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      locationId: "location-123",
      email: "new@example.com",
      name: "New User",
      source: "Uplift signup",
      firstName: "New",
      lastName: "User",
      phone: "+14165550123",
      companyName: "New Co",
      website: "https://new.example.com",
      tags: ["uplift-signup", "uplift-free-signup", "uplift-nurture", "trial"],
      customFields: [{ id: "custom-user-id", field_value: "user-1" }],
    });
  });

  it("resolves configured signup placeholders for GHL custom fields", async () => {
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_TAGS = "uplift-signup,trial";
    process.env.GHL_SIGNUP_SOURCE = "Uplift auto signup";
    process.env.GHL_SIGNUP_USER_ID_FIELD_ID = "HzmLr2KCF3FmmCRX4LZH";
    process.env.GHL_SIGNUP_CUSTOM_FIELDS_JSON =
      '[{"id":"daz6aQUObpH3zhGOlUUu","field_value":"Trial"},{"id":"cqAADemoJ6e3jQSJZ8uO","field_value":"Active"},{"id":"f0tPSGUDqAqUc1bnxt77","field_value":"{{signup_date}}"},{"id":"8GxnDntGiZDIVadO9SNS","field_value":"{{trial_start_date}}"},{"id":"EqbtxDdAnZeOmIupTeQo","field_value":"{{trial_end_date}}"},{"id":"HzmLr2KCF3FmmCRX4LZH","field_value":"{{uplift_user_id}}"}]';

    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ contact: { id: "contact-123" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      id: "user-123",
      email: "signup@example.com",
      name: "Signup User",
      createdAt: "2026-06-10T15:30:00.000Z",
    });

    expect(result).toEqual({ status: "synced", contactId: "contact-123" });
    expect(capturedBody?.locationId).toBe("location-123");
    expect(capturedBody?.email).toBe("signup@example.com");
    expect(capturedBody?.name).toBe("Signup User");
    expect(capturedBody?.source).toBe("Uplift auto signup");
    expect(capturedBody?.firstName).toBe("Signup");
    expect(capturedBody?.lastName).toBe("User");
    expect(capturedBody?.tags).toEqual([
      "uplift-signup",
      "uplift-free-signup",
      "uplift-nurture",
      "trial",
    ]);
    expect(capturedBody?.customFields).toEqual([
      { id: "daz6aQUObpH3zhGOlUUu", field_value: "Trial" },
      { id: "cqAADemoJ6e3jQSJZ8uO", field_value: "Active" },
      { id: "f0tPSGUDqAqUc1bnxt77", field_value: "2026-06-10" },
      { id: "8GxnDntGiZDIVadO9SNS", field_value: "2026-06-10" },
      { id: "EqbtxDdAnZeOmIupTeQo", field_value: "2026-06-17" },
      { id: "HzmLr2KCF3FmmCRX4LZH", field_value: "user-123" },
    ]);
  });

  it("creates a New Lead opportunity after contact upsert when configured", async () => {
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_SOURCE = "Uplift auto signup";
    process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED = "true";
    process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID = "pipeline-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID = "stage-new-lead";
    process.env.GHL_SIGNUP_OPPORTUNITY_NAME_TEMPLATE =
      "{{name}} - Uplift trial";
    process.env.GHL_SIGNUP_OPPORTUNITY_MONETARY_VALUE = "99";
    process.env.GHL_SIGNUP_ASSIGNED_TO_USER_ID = "vishal-user-id";

    const calls: Array<{ body?: Record<string, unknown>; url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        url: String(url),
      });

      if (String(url).endsWith("/contacts/upsert")) {
        return new Response(JSON.stringify({ contact: { id: "contact-123" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(url).includes("/opportunities/search")) {
        return new Response(JSON.stringify({ opportunities: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ opportunity: { id: "opportunity-123" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      id: "user-1",
      email: "Lead@Example.com",
      name: "Lead User",
      phone: "+14165550123",
    });

    expect(result).toEqual({
      status: "synced",
      contactId: "contact-123",
      opportunity: { status: "created", opportunityId: "opportunity-123" },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://services.example.test/contacts/upsert",
      "https://services.example.test/opportunities/search?location_id=location-123&contact_id=contact-123&pipeline_id=pipeline-123",
      "https://services.example.test/opportunities/",
    ]);
    expect(calls[0]?.body?.assignedTo).toBe("vishal-user-id");
    expect(calls[0]?.body?.email).toBe("lead@example.com");
    expect(calls[0]?.body?.phone).toBe("+14165550123");
    expect(calls[2]?.body).toEqual({
      assignedTo: "vishal-user-id",
      contactId: "contact-123",
      locationId: "location-123",
      monetaryValue: 99,
      name: "Lead User - Uplift trial",
      pipelineId: "pipeline-123",
      pipelineStageId: "stage-new-lead",
      source: "Uplift auto signup",
      status: "open",
    });
  });

  it("routes Indian signups to the lost opportunity stage", async () => {
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED = "true";
    process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID = "pipeline-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID = "stage-new-lead";
    process.env.GHL_SIGNUP_OPPORTUNITY_LOST_STAGE_ID = "stage-lost";
    process.env.GHL_SIGNUP_ASSIGNED_TO_USER_ID = "vishal-user-id";

    const calls: Array<{ body?: Record<string, unknown>; url: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        url: String(url),
      });

      if (String(url).endsWith("/contacts/upsert")) {
        return new Response(JSON.stringify({ contact: { id: "contact-123" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(url).includes("/opportunities/search")) {
        return new Response(JSON.stringify({ opportunities: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({ opportunity: { id: "opportunity-123" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      country: "India",
      email: "lead@example.com",
      id: "user-1",
      name: "Lead User",
      phone: "+919876543210",
    });

    expect(result).toEqual({
      status: "synced",
      contactId: "contact-123",
      opportunity: { status: "created", opportunityId: "opportunity-123" },
    });
    expect(calls[2]?.body?.contactId).toBe("contact-123");
    expect(calls[2]?.body?.pipelineId).toBe("pipeline-123");
    expect(calls[2]?.body?.pipelineStageId).toBe("stage-lost");
    expect(calls[2]?.body?.status).toBe("lost");
    expect("assignedTo" in (calls[0]?.body ?? {})).toBe(false);
    expect("assignedTo" in (calls[2]?.body ?? {})).toBe(false);
  });

  it("skips opportunity creation when the direct signup already has one", async () => {
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED = "true";
    process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID = "pipeline-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID = "stage-new-lead";

    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));

      if (String(url).endsWith("/contacts/upsert")) {
        return new Response(JSON.stringify({ contact: { id: "contact-123" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(url).includes("/opportunities/search")) {
        return new Response(
          JSON.stringify({ opportunities: [{ id: "opportunity-existing" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({ opportunity: { id: "opportunity-new" } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      email: "duplicate@example.com",
      id: "user-1",
      name: "Duplicate User",
    });

    expect(result).toEqual({
      status: "synced",
      contactId: "contact-123",
      opportunity: {
        status: "skipped",
        reason: "duplicate-opportunity",
        existingOpportunityId: "opportunity-existing",
      },
    });
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe("https://services.example.test/contacts/upsert");
    expect(calls[1]).toBe(
      "https://services.example.test/opportunities/search?location_id=location-123&contact_id=contact-123&pipeline_id=pipeline-123",
    );
  });

  it("keeps contact sync successful when configured opportunity creation fails", async () => {
    process.env.GHL_API_BASE_URL = "https://services.example.test";
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED = "true";
    process.env.GHL_SIGNUP_OPPORTUNITY_PIPELINE_ID = "pipeline-123";
    process.env.GHL_SIGNUP_OPPORTUNITY_STAGE_ID = "stage-new-lead";

    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/contacts/upsert")) {
        return new Response(JSON.stringify({ contact: { id: "contact-123" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (String(url).includes("/opportunities/search")) {
        return new Response(JSON.stringify({ opportunities: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ message: "Invalid pipeline" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      id: "user-1",
      email: "new@example.com",
      name: "New User",
    });

    expect(result).toEqual({
      status: "synced",
      contactId: "contact-123",
      opportunity: { status: "failed", reason: "Invalid pipeline" },
    });
  });

  it("returns failure details without throwing when GHL rejects the request", async () => {
    process.env.GHL_API_TOKEN = "ghl-token";
    process.env.GHL_LOCATION_ID = "location-123";

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const result = await syncSignupToGhl({
      id: "user-1",
      email: "new@example.com",
      name: "New User",
    });

    expect(result).toEqual({ status: "failed", reason: "Invalid token" });
  });
});
