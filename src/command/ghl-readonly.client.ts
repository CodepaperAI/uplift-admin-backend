export type GhlContact = {
  id: string;
  locationId?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  country?: string;
  source?: string;
  assignedTo?: string;
  tags?: string[];
  customFields?: unknown;
  dateAdded?: string;
  dateUpdated?: string;
};

export type GhlOpportunity = {
  id: string;
  locationId?: string;
  contactId?: string;
  name?: string;
  monetaryValue?: number | string;
  pipelineId?: string;
  pipelineStageId?: string;
  assignedTo?: string;
  status?: string;
  source?: string;
  lostReasonId?: string;
  lastStatusChangeAt?: string;
  lastStageChangeAt?: string;
  lastActionDate?: string;
  createdAt?: string;
  updatedAt?: string;
  forecastExpectedCloseDate?: string;
};

export type GhlUser = {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  roles?: { type?: string; role?: string };
};

export type GhlPipeline = {
  id: string;
  name?: string;
  stages?: Array<{ id: string; name?: string }>;
};

export type GhlPaymentSubscription = {
  _id: string;
  altId?: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  currency?: string;
  amount?: number | string;
  status?: unknown;
  liveMode?: boolean;
  entityType?: string;
  entityId?: string;
  entitySourceType?: string;
  entitySourceName?: string;
  entitySourceId?: string;
  subscriptionId?: string;
  paymentProviderType?: string;
  paymentProviderConnectedAccount?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GhlPaymentTransaction = {
  _id: string;
  altId?: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  currency?: string;
  amount?: number | string;
  amountRefunded?: number | string;
  status?: unknown;
  liveMode?: boolean;
  entityType?: string;
  entityId?: string;
  entitySourceType?: string;
  entitySourceSubType?: string;
  entitySourceName?: string;
  entitySourceId?: string;
  subscriptionId?: string;
  chargeId?: string;
  paymentProviderType?: string;
  paymentProviderConnectedAccount?: string;
  fulfilledAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GhlCallMessage = {
  id: string;
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  dateAdded?: string;
  direction?: "inbound" | "outbound" | string;
  status?: string;
  messageType?: string;
  userId?: string;
  meta?: { callDuration?: string; callStatus?: string };
};

export type GhlCalendarEvent = {
  id: string;
  locationId?: string;
  contactId?: string;
  assignedUserId?: string;
  users?: string[];
  appointmentStatus?: string;
  startTime?: unknown;
  endTime?: unknown;
};

type GhlClientConfig = {
  token: string;
  locationId: string;
  baseUrl?: string;
  contactsVersion?: string;
  opportunitiesVersion?: string;
  paymentsVersion?: string;
  conversationsVersion?: string;
  calendarsVersion?: string;
  usersVersion?: string;
  funnelsVersion?: string;
  locationsVersion?: string;
  fetchImpl?: typeof fetch;
};

export class GhlReadOnlyClient {
  private readonly token: string;
  private readonly locationId: string;
  private readonly baseUrl: string;
  private readonly contactsVersion: string;
  private readonly opportunitiesVersion: string;
  private readonly paymentsVersion: string;
  private readonly conversationsVersion: string;
  private readonly calendarsVersion: string;
  private readonly usersVersion: string;
  private readonly funnelsVersion: string;
  private readonly locationsVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GhlClientConfig) {
    if (!config.token.trim() || !config.locationId.trim()) {
      throw new Error("GHL read sync requires a token and location id");
    }
    this.token = config.token.trim();
    this.locationId = config.locationId.trim();
    this.baseUrl = (
      config.baseUrl ?? "https://services.leadconnectorhq.com"
    ).replace(/\/$/, "");
    this.contactsVersion = config.contactsVersion ?? "2023-02-21";
    this.opportunitiesVersion = config.opportunitiesVersion ?? "v3";
    this.paymentsVersion = config.paymentsVersion ?? "2021-07-28";
    this.conversationsVersion = config.conversationsVersion ?? "v3";
    this.calendarsVersion = config.calendarsVersion ?? "2021-04-15";
    this.usersVersion = config.usersVersion ?? "2021-07-28";
    this.funnelsVersion = config.funnelsVersion ?? "2021-07-28";
    this.locationsVersion = config.locationsVersion ?? "2021-07-28";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, version: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        Version: version,
      },
    });
    const payload = (await response.json().catch(() => null)) as
      | (T & { message?: string; error?: string })
      | null;
    if (!response.ok || payload === null) {
      throw new Error(
        payload?.message ||
          payload?.error ||
          `GHL read request failed (${response.status})`,
      );
    }
    return payload;
  }

  async contactsPage(cursor?: { id: string; timestamp?: number }) {
    const query = new URLSearchParams({
      locationId: this.locationId,
      limit: "100",
    });
    if (cursor) {
      query.set("startAfterId", cursor.id);
      if (cursor.timestamp) query.set("startAfter", String(cursor.timestamp));
    }
    const result = await this.get<{ contacts?: GhlContact[] }>(
      `/contacts/?${query.toString()}`,
      this.contactsVersion,
    );
    if (!Array.isArray(result.contacts)) {
      throw new Error("GHL contacts response did not contain a contacts array");
    }
    return result.contacts;
  }

  async opportunitiesPage(page: number) {
    const query = new URLSearchParams({
      locationId: this.locationId,
      limit: "100",
      page: String(page),
    });
    const result = await this.get<{ opportunities?: GhlOpportunity[] }>(
      `/opportunities/search?${query.toString()}`,
      this.opportunitiesVersion,
    );
    if (!Array.isArray(result.opportunities)) {
      throw new Error(
        "GHL opportunities response did not contain an opportunities array",
      );
    }
    return result.opportunities;
  }

  /**
   * The people in the location, so an `assignedTo` id can be given a name.
   *
   * The sync stores `assignedToGhlId` on every opportunity but nothing anywhere
   * maps that id to a person, which is why every opportunity in the panel reads
   * "Unassigned" — there are nine distinct assignee ids across the pipeline and
   * no way to tell whose they are. This is the lookup that fixes it.
   *
   * Uses the users version rather than the opportunities one: GHL versions its
   * endpoints independently and the users route answers on 2021-07-28.
   */
  async users() {
    const query = new URLSearchParams({ locationId: this.locationId });
    const result = await this.get<{ users?: GhlUser[] }>(
      `/users/?${query.toString()}`,
      this.usersVersion,
    );
    if (!Array.isArray(result.users)) {
      throw new Error("GHL users response did not contain a users array");
    }
    return result.users;
  }

  /**
   * The funnels on the location, and the pages inside one.
   *
   * Added to answer a specific question with evidence rather than memory: does
   * GHL's API expose a funnel's tracking-code fields, and what is the live
   * booking page's actual path. Both are read-only lookups.
   */
  async funnels() {
    const query = new URLSearchParams({ locationId: this.locationId, limit: "100" });
    const result = await this.get<{ funnels?: unknown[] }>(
      `/funnels/lookup?${query.toString()}`,
      this.funnelsVersion,
    );
    return Array.isArray(result.funnels) ? result.funnels : [];
  }

  async funnelPages(funnelId: string) {
    const query = new URLSearchParams({
      locationId: this.locationId,
      funnelId,
      limit: "100",
      offset: "0",
    });
    const result = await this.get<{ pages?: unknown[] }>(
      `/funnels/page?${query.toString()}`,
      this.funnelsVersion,
    );
    return Array.isArray(result.pages) ? result.pages : [];
  }

  /** The location record. Field names only are ever surfaced — see the caller. */
  async location() {
    return this.get<Record<string, unknown>>(
      `/locations/${this.locationId}`,
      this.locationsVersion,
    );
  }

  async pipelines() {
    const query = new URLSearchParams({ locationId: this.locationId });
    const result = await this.get<{ pipelines?: GhlPipeline[] }>(
      `/opportunities/pipelines?${query.toString()}`,
      this.opportunitiesVersion,
    );
    if (!Array.isArray(result.pipelines)) {
      throw new Error("GHL pipelines response did not contain a pipelines array");
    }
    return result.pipelines;
  }

  private paymentQuery(offset: number) {
    return new URLSearchParams({
      altId: this.locationId,
      altType: "location",
      paymentMode: "live",
      limit: "100",
      offset: String(offset),
    });
  }

  async paymentSubscriptionsPage(offset: number) {
    const result = await this.get<{
      data?: GhlPaymentSubscription[];
      totalCount?: number;
    }>(
      `/payments/subscriptions?${this.paymentQuery(offset).toString()}`,
      this.paymentsVersion,
    );
    if (!Array.isArray(result.data) || typeof result.totalCount !== "number") {
      throw new Error(
        "GHL payment subscriptions response did not match the documented schema",
      );
    }
    return { data: result.data, totalCount: result.totalCount };
  }

  async paymentTransactionsPage(offset: number) {
    const result = await this.get<{
      data?: GhlPaymentTransaction[];
      totalCount?: number;
    }>(
      `/payments/transactions?${this.paymentQuery(offset).toString()}`,
      this.paymentsVersion,
    );
    if (!Array.isArray(result.data) || typeof result.totalCount !== "number") {
      throw new Error(
        "GHL payment transactions response did not match the documented schema",
      );
    }
    return { data: result.data, totalCount: result.totalCount };
  }

  async callMessagesPage(input: {
    startDate: string;
    endDate: string;
    cursor?: string;
  }) {
    const query = new URLSearchParams({
      locationId: this.locationId,
      channel: "Call",
      limit: "500",
      sortBy: "createdAt",
      sortOrder: "asc",
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (input.cursor) query.set("cursor", input.cursor);
    const result = await this.get<{
      messages?: GhlCallMessage[];
      nextCursor?: string | null;
      total?: number;
    }>(
      `/conversations/messages/export?${query.toString()}`,
      this.conversationsVersion,
    );
    if (!Array.isArray(result.messages) || typeof result.total !== "number") {
      throw new Error(
        "GHL call export response did not match the documented schema",
      );
    }
    return {
      messages: result.messages,
      nextCursor: result.nextCursor ?? null,
      total: result.total,
    };
  }

  async calendarEventsForUser(input: {
    userId: string;
    startTime: Date;
    endTime: Date;
  }) {
    const query = new URLSearchParams({
      locationId: this.locationId,
      userId: input.userId,
      startTime: String(input.startTime.getTime()),
      endTime: String(input.endTime.getTime() - 1),
    });
    const result = await this.get<{ events?: GhlCalendarEvent[] }>(
      `/calendars/events?${query.toString()}`,
      this.calendarsVersion,
    );
    if (!Array.isArray(result.events)) {
      throw new Error(
        "GHL calendar events response did not match the documented schema",
      );
    }
    return result.events;
  }
}
