import { describe, expect, it } from "bun:test";
import { Prisma } from "@prisma/client";
import { MetaAdsReadOnlyClient } from "../command/meta-ads-readonly.client";
import { aggregateMetaCampaignSpend } from "../command/meta-ads-sync.service";

describe("Meta Ads read-only projection", () => {
  it("uses only GET requests, bearer auth, explicit version, and cursor pagination", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const payload = url.includes("/insights?")
        ? { data: [], paging: { cursors: { after: "next" } } }
        : { currency: "CAD" };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new MetaAdsReadOnlyClient({
      accessToken: "secret-token",
      adAccountId: "123",
      apiVersion: "v25.0",
      baseUrl: "https://graph.example",
      fetchImpl,
    });

    expect(await client.accountCurrency()).toBe("cad");
    expect(
      await client.campaignInsightsPage("2026-08-01", "2026-08-31", "abc"),
    ).toEqual({ data: [], after: "next" });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.init?.method).toBe("GET");
      expect(new Headers(request.init?.headers).get("Authorization")).toBe(
        "Bearer secret-token",
      );
      expect(request.url).toStartWith("https://graph.example/v25.0/act_123");
      expect(request.url).not.toContain("secret-token");
    }
    const insightsUrl = new URL(requests[1]!.url);
    expect(insightsUrl.searchParams.get("level")).toBe("campaign");
    expect(insightsUrl.searchParams.get("after")).toBe("abc");
    expect(insightsUrl.searchParams.get("time_increment")).toBe("monthly");
  });

  it("requires an explicit API version", () => {
    expect(
      () =>
        new MetaAdsReadOnlyClient({
          accessToken: "token",
          adAccountId: "act_1",
          apiVersion: "",
        }),
    ).toThrow("explicit API version");
  });

  it("aggregates campaign spend exactly without floating point", () => {
    const result = aggregateMetaCampaignSpend([
      { campaign_id: "one", campaign_name: "Launch", spend: "10.10" },
      { campaign_id: "one", campaign_name: "Launch", spend: "0.20" },
      { campaign_id: "two", campaign_name: "Retargeting", spend: "4" },
    ]);
    expect(result.map((row) => ({ ...row, spend: row.spend.toString() }))).toEqual([
      { campaignId: "one", campaignName: "Launch", spend: "10.3" },
      { campaignId: "two", campaignName: "Retargeting", spend: "4" },
    ]);
    expect(result[0]!.spend.equals(new Prisma.Decimal("10.30"))).toBe(true);
  });
});
