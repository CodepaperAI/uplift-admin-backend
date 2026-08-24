const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";
const ZERNIO_REQUEST_TIMEOUT_MS = 15_000;

export const UPLIFT_TO_ZERNIO_PLATFORM = {
  instagram: "instagram",
  facebook: "facebook",
  linkedin: "linkedin",
  x: "twitter",
} as const;

export const ZERNIO_TO_UPLIFT_PLATFORM = {
  instagram: "instagram",
  facebook: "facebook",
  linkedin: "linkedin",
  twitter: "x",
} as const;

export type UpliftSocialPlatform = keyof typeof UPLIFT_TO_ZERNIO_PLATFORM;
export type ZernioSocialPlatform =
  (typeof UPLIFT_TO_ZERNIO_PLATFORM)[UpliftSocialPlatform];

export class ZernioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly existingResourceId: string | null = null,
  ) {
    super(message);
    this.name = "ZernioApiError";
  }
}

export type ZernioWebhookSetting = {
  _id: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
};

export type ZernioAccount = {
  _id: string;
  platform: string;
  username?: string | null;
  displayName?: string | null;
  profileUrl?: string | null;
  avatarUrl?: string | null;
  profilePicture?: string | null;
  isActive?: boolean;
};

type ZernioPostPlatform = {
  platform?: string;
  status?: string;
  platformPostUrl?: string | null;
  errorCategory?: string | null;
  errorMessage?: string | null;
  errorSource?: string | null;
};

export type ZernioPost = {
  _id: string;
  status?: string;
  scheduledFor?: string | null;
  platformPostUrl?: string | null;
  platforms?: ZernioPostPlatform[];
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | boolean | null | undefined>;
  body?: unknown;
  requestId?: string;
  idempotencyKey?: string;
};

function configuredApiKey(): string {
  const apiKey = process.env.ZERNIO_API_KEY?.trim();
  if (!apiKey) {
    throw new ZernioApiError(
      "Social publishing is not configured",
      503,
      "ZERNIO_NOT_CONFIGURED",
      false,
    );
  }
  return apiKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unwrapPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.data) ? value.data : value;
}

function providerMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const message = value.error ?? value.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 500)
    : fallback;
}

function providerCode(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.code === "string" && value.code.trim()) {
    return value.code.trim().slice(0, 120);
  }
  return `ZERNIO_HTTP_${status}`;
}

function providerExistingResourceId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const existingPost = isRecord(value.existingPost) ? value.existingPost : null;
  const candidate = value.existingPostId ?? existingPost?._id;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim().slice(0, 200)
    : null;
}

export class ZernioClient {
  constructor(
    private readonly apiKey = configuredApiKey(),
    private readonly baseUrl = ZERNIO_API_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ZERNIO_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.requestId ? { "x-request-id": options.requestId } : {}),
          ...(options.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new ZernioApiError(
          providerMessage(payload, "Zernio request failed"),
          response.status,
          providerCode(payload, response.status),
          response.status === 408 || response.status === 429 || response.status >= 500,
          providerExistingResourceId(payload),
        );
      }
      return unwrapPayload(payload);
    } catch (error) {
      if (error instanceof ZernioApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ZernioApiError(
          "Zernio request timed out",
          504,
          "ZERNIO_TIMEOUT",
          true,
        );
      }
      throw new ZernioApiError(
        "Zernio is temporarily unavailable",
        503,
        "ZERNIO_NETWORK_ERROR",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async createProfile(input: {
    name: string;
    description?: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    const result = await this.request("/profiles", {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: { name: input.name, description: input.description },
    });
    const profile = isRecord(result.profile) ? result.profile : result;
    const id = profile._id;
    if (typeof id !== "string" || !id.trim()) {
      throw new ZernioApiError(
        "Zernio returned an invalid profile",
        502,
        "ZERNIO_INVALID_PROFILE_RESPONSE",
        false,
      );
    }
    return { id: id.trim() };
  }

  async getConnectUrl(input: {
    platform: ZernioSocialPlatform;
    profileId: string;
    redirectUrl: string;
  }): Promise<string> {
    const result = await this.request(`/connect/${input.platform}`, {
      query: {
        profileId: input.profileId,
        redirect_url: input.redirectUrl,
        headless: false,
      },
    });
    const authUrl = result.authUrl;
    if (typeof authUrl !== "string" || !/^https:\/\//i.test(authUrl)) {
      throw new ZernioApiError(
        "Zernio returned an invalid connection URL",
        502,
        "ZERNIO_INVALID_CONNECT_RESPONSE",
        false,
      );
    }
    return authUrl;
  }

  async listAccounts(profileId: string): Promise<ZernioAccount[]> {
    const result = await this.request("/accounts", {
      query: { profileId },
    });
    const accounts = Array.isArray(result.accounts) ? result.accounts : [];
    return accounts.filter(
      (account): account is ZernioAccount =>
        isRecord(account) && typeof account._id === "string" && typeof account.platform === "string",
    );
  }

  async disconnectAccount(accountId: string): Promise<void> {
    await this.request(`/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
  }

  async getPost(postId: string): Promise<ZernioPost> {
    const result = await this.request(
      `/posts/${encodeURIComponent(postId)}`,
    );
    const postValue = isRecord(result.post) ? result.post : result;
    if (typeof postValue._id !== "string" || !postValue._id.trim()) {
      throw new ZernioApiError(
        "Zernio returned an invalid post status",
        502,
        "ZERNIO_INVALID_POST_RESPONSE",
        false,
      );
    }
    return postValue as ZernioPost;
  }

  private async findPostByAttemptMetadata(
    metadata: Record<string, string>,
  ): Promise<ZernioPost | null> {
    const attemptId = metadata.upliftAttemptId?.trim();
    if (!attemptId) return null;
    const result = await this.request("/posts", {
      query: { limit: "100" },
    });
    const posts = Array.isArray(result.posts) ? result.posts : [];
    const match = posts.find(
      (candidate) =>
        isRecord(candidate) &&
        isRecord(candidate.metadata) &&
        candidate.metadata.upliftAttemptId === attemptId,
    );
    return isRecord(match) && typeof match._id === "string"
      ? (match as ZernioPost)
      : null;
  }

  async createPost(
    input: {
      title: string;
      content: string;
      mediaUrl?: string | null;
      mediaUrls?: string[];
      platform: ZernioSocialPlatform;
      accountId: string;
      publishNow: boolean;
      scheduledFor?: string;
      timezone: string;
      metadata: Record<string, string>;
    },
    requestId: string,
  ): Promise<ZernioPost> {
    let result: Record<string, unknown>;
    const mediaUrls = Array.from(
      new Set(
        (input.mediaUrls?.length ? input.mediaUrls : [input.mediaUrl])
          .filter(
            (url): url is string =>
              typeof url === "string" && Boolean(url.trim()),
          )
          .map((url) => url.trim()),
      ),
    );
    try {
      result = await this.request("/posts", {
        method: "POST",
        requestId,
        body: {
          title: input.title,
          content: input.content,
          mediaItems: mediaUrls.map((url) => ({ type: "image", url })),
          platforms: [
            {
              platform: input.platform,
              accountId: input.accountId,
              customContent: input.content,
              ...(input.platform === "instagram"
                ? { platformSpecificData: { isAiGenerated: true } }
                : {}),
            },
          ],
          publishNow: input.publishNow,
          ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
          timezone: input.timezone,
          crosspostingEnabled: false,
          metadata: input.metadata,
        },
      });
    } catch (error) {
      // A provider post may have succeeded just before our process lost its
      // response/DB write. Zernio's 24-hour content dedupe returns the
      // original post ID, which is safe to adopt on a durable retry.
      if (
        error instanceof ZernioApiError &&
        error.status === 409 &&
        error.existingResourceId
      ) {
        return { _id: error.existingResourceId, status: "processing" };
      }
      if (
        error instanceof ZernioApiError &&
        (error.status === 409 || error.retryable)
      ) {
        try {
          const existingPost = await this.findPostByAttemptMetadata(
            input.metadata,
          );
          if (existingPost) return existingPost;
        } catch {
          // Keep the original publish error when the read-only reconciliation
          // lookup is unavailable. Inngest can safely retry the same attempt.
        }
      }
      throw error;
    }
    const postValue = isRecord(result.post)
      ? result.post
      : isRecord(result.existingPost)
        ? result.existingPost
        : result;
    if (typeof postValue._id !== "string" || !postValue._id.trim()) {
      throw new ZernioApiError(
        "Zernio returned an invalid post",
        502,
        "ZERNIO_INVALID_POST_RESPONSE",
        false,
      );
    }
    return postValue as ZernioPost;
  }

  async retryPost(postId: string): Promise<ZernioPost> {
    const result = await this.request(
      `/posts/${encodeURIComponent(postId)}/retry`,
      { method: "POST" },
    );
    const postValue = isRecord(result.post) ? result.post : result;
    if (typeof postValue._id !== "string") {
      throw new ZernioApiError(
        "Zernio returned an invalid retry response",
        502,
        "ZERNIO_INVALID_POST_RESPONSE",
        false,
      );
    }
    return postValue as ZernioPost;
  }

  async listWebhookSettings(): Promise<ZernioWebhookSetting[]> {
    const result = await this.request("/webhooks/settings");
    const webhooks = Array.isArray(result.webhooks) ? result.webhooks : [];
    return webhooks.filter(
      (webhook): webhook is ZernioWebhookSetting =>
        isRecord(webhook) &&
        typeof webhook._id === "string" &&
        typeof webhook.name === "string" &&
        typeof webhook.url === "string" &&
        Array.isArray(webhook.events) &&
        typeof webhook.isActive === "boolean",
    );
  }

  async createWebhookSetting(input: {
    name: string;
    url: string;
    secret: string;
    events: string[];
  }): Promise<ZernioWebhookSetting> {
    const result = await this.request("/webhooks/settings", {
      method: "POST",
      body: { ...input, isActive: true },
    });
    const webhook = isRecord(result.webhook) ? result.webhook : result;
    if (typeof webhook._id !== "string") {
      throw new ZernioApiError(
        "Zernio returned an invalid webhook",
        502,
        "ZERNIO_INVALID_WEBHOOK_RESPONSE",
        false,
      );
    }
    return webhook as ZernioWebhookSetting;
  }

  async updateWebhookSetting(input: {
    id: string;
    name: string;
    url: string;
    secret: string;
    events: string[];
  }): Promise<ZernioWebhookSetting> {
    const result = await this.request("/webhooks/settings", {
      method: "PUT",
      body: {
        _id: input.id,
        name: input.name,
        url: input.url,
        secret: input.secret,
        events: input.events,
        isActive: true,
      },
    });
    const webhook = isRecord(result.webhook) ? result.webhook : result;
    if (typeof webhook._id !== "string") {
      throw new ZernioApiError(
        "Zernio returned an invalid webhook",
        502,
        "ZERNIO_INVALID_WEBHOOK_RESPONSE",
        false,
      );
    }
    return webhook as ZernioWebhookSetting;
  }
}
