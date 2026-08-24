import { describe, expect, it } from "bun:test";
import { GhlReadOnlyClient } from "../command/ghl-readonly.client";

describe("Command GHL read-only client", () => {
  it("uses GET-only provider requests with readonly API versions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(
        String(url).includes("/payments/")
          ? { data: [], totalCount: 0 }
          : { contacts: [], opportunities: [], pipelines: [] },
      );
    }) as typeof fetch;
    const client = new GhlReadOnlyClient({
      token: "secret-token",
      locationId: "location-1",
      baseUrl: "https://ghl.example.test/",
      fetchImpl,
    });

    await client.contactsPage();
    await client.opportunitiesPage(2);
    await client.pipelines();
    await client.paymentSubscriptionsPage(0);
    await client.paymentTransactionsPage(100);

    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
    expect(calls[0]?.url).toContain("locationId=location-1");
    expect(calls[1]?.url).toContain("page=2");
    expect(new Headers(calls[0]?.init?.headers).get("Version")).toBe(
      "2023-02-21",
    );
    expect(new Headers(calls[1]?.init?.headers).get("Version")).toBe("v3");
    expect(calls[3]?.url).toContain(
      "/payments/subscriptions?altId=location-1&altType=location&paymentMode=live&limit=100&offset=0",
    );
    expect(calls[4]?.url).toContain("/payments/transactions?");
    expect(calls[4]?.url).toContain("offset=100");
    expect(new Headers(calls[4]?.init?.headers).get("Version")).toBe(
      "2021-07-28",
    );
  });

  it("refuses to initialize without isolated read-sync credentials", () => {
    expect(
      () => new GhlReadOnlyClient({ token: "", locationId: "location-1" }),
    ).toThrow("requires a token and location id");
  });
});
