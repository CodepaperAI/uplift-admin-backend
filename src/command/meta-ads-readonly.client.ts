export type MetaAdsInsight = {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  date_start?: string;
  date_stop?: string;
};

type MetaAdsClientConfig = {
  accessToken: string;
  adAccountId: string;
  apiVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

type MetaCollection<T> = {
  data?: T[];
  paging?: { cursors?: { after?: string } };
  error?: { message?: string };
};

export class MetaAdsReadOnlyClient {
  private readonly accessToken: string;
  private readonly accountId: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MetaAdsClientConfig) {
    const accessToken = config.accessToken.trim();
    const rawAccountId = config.adAccountId.trim();
    const apiVersion = config.apiVersion.trim();
    if (!accessToken || !rawAccountId || !apiVersion) {
      throw new Error(
        "Meta Ads read sync requires an access token, ad account id, and explicit API version",
      );
    }
    if (!/^v\d+\.\d+$/.test(apiVersion)) {
      throw new Error("META_GRAPH_API_VERSION must look like v25.0");
    }
    this.accessToken = accessToken;
    this.accountId = rawAccountId.startsWith("act_")
      ? rawAccountId
      : `act_${rawAccountId}`;
    this.apiVersion = apiVersion;
    this.baseUrl = (config.baseUrl ?? "https://graph.facebook.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get adAccountId(): string {
    return this.accountId;
  }

  private async get<T>(path: string, query: URLSearchParams): Promise<T> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/${this.apiVersion}/${path}?${query.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (!response.ok || payload === null) {
      throw new Error(
        payload?.error?.message ??
          `Meta Ads read request failed (${response.status})`,
      );
    }
    return payload;
  }

  async accountCurrency(): Promise<string> {
    const payload = await this.get<{ currency?: string }>(
      this.accountId,
      new URLSearchParams({ fields: "currency" }),
    );
    if (!payload.currency || !/^[A-Za-z]{3}$/.test(payload.currency)) {
      throw new Error("Meta Ads account response did not include a currency");
    }
    return payload.currency.toLowerCase();
  }

  async campaignInsightsPage(
    since: string,
    until: string,
    after?: string,
  ): Promise<{ data: MetaAdsInsight[]; after: string | null }> {
    const query = new URLSearchParams({
      fields: "campaign_id,campaign_name,spend,date_start,date_stop",
      level: "campaign",
      time_increment: "monthly",
      time_range: JSON.stringify({ since, until }),
      limit: "500",
    });
    if (after) query.set("after", after);
    const payload = await this.get<MetaCollection<MetaAdsInsight>>(
      `${this.accountId}/insights`,
      query,
    );
    if (!Array.isArray(payload.data)) {
      throw new Error("Meta Ads insights response did not contain a data array");
    }
    return {
      data: payload.data,
      after: payload.paging?.cursors?.after ?? null,
    };
  }
}
