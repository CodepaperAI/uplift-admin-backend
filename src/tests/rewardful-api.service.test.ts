import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  getRewardfulApiHealth,
  listRewardfulRemoteResource,
} from "../services/rewardful-api.service";

const ORIGINAL_API_SECRET = process.env.REWARDFUL_API_SECRET;
const originalFetch = globalThis.fetch;

let fetchCalls: Array<{
  headers?: HeadersInit;
  method?: string;
  url: string;
}> = [];

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("Rewardful API service", () => {
  beforeEach(() => {
    fetchCalls = [];
    process.env.REWARDFUL_API_SECRET = "rewardful-api-secret";
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          headers: init?.headers,
          method: init?.method,
          url: input.toString(),
        });
        return mockJsonResponse({ data: [], pagination: { count: 0 } });
      },
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env.REWARDFUL_API_SECRET = ORIGINAL_API_SECRET;
    globalThis.fetch = originalFetch;
  });

  it("uses the Rewardful API secret as a Basic Auth username", async () => {
    const params = new URLSearchParams({ limit: "10" });
    const result = await listRewardfulRemoteResource("referrals", params);

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.url).toBe(
      "https://api.getrewardful.com/v1/referrals?limit=10",
    );
    expect(fetchCalls[0]?.headers).toEqual({
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from("rewardful-api-secret:").toString("base64")}`,
    });
  });

  it("checks all reporting resources for internal health", async () => {
    const health = await getRewardfulApiHealth();

    expect(health).toEqual({
      configured: true,
      ok: true,
      checks: [
        { error: null, ok: true, resource: "affiliates", status: 200 },
        { error: null, ok: true, resource: "referrals", status: 200 },
        { error: null, ok: true, resource: "commissions", status: 200 },
        { error: null, ok: true, resource: "payouts", status: 200 },
      ],
    });
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://api.getrewardful.com/v1/affiliates?limit=1",
      "https://api.getrewardful.com/v1/referrals?limit=1",
      "https://api.getrewardful.com/v1/commissions?limit=1",
      "https://api.getrewardful.com/v1/payouts?limit=1",
    ]);
  });

  it("fails closed when REWARDFUL_API_SECRET is missing", async () => {
    process.env.REWARDFUL_API_SECRET = "";

    const health = await getRewardfulApiHealth();

    expect(health.configured).toBe(false);
    expect(health.ok).toBe(false);
    expect(health.checks.every((check) => check.status === 503)).toBe(true);
    expect(fetchCalls).toEqual([]);
  });
});
