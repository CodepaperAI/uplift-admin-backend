const REWARDFUL_API_BASE_URL = "https://api.getrewardful.com/v1";

export const REWARDFUL_REMOTE_RESOURCES = [
  "affiliates",
  "referrals",
  "commissions",
  "payouts",
] as const;

export type RewardfulRemoteResource =
  (typeof REWARDFUL_REMOTE_RESOURCES)[number];

export type RewardfulApiResult<T = unknown> = {
  data: T | null;
  error: string | null;
  ok: boolean;
  status: number;
};

export type RewardfulApiHealthCheck = {
  resource: RewardfulRemoteResource;
  ok: boolean;
  status: number;
  error: string | null;
};

export type RewardfulApiHealth = {
  configured: boolean;
  ok: boolean;
  checks: RewardfulApiHealthCheck[];
};

function getRewardfulApiSecret(): string {
  return process.env.REWARDFUL_API_SECRET?.trim() ?? "";
}

function buildAuthHeader(apiSecret: string): string {
  return `Basic ${Buffer.from(`${apiSecret}:`).toString("base64")}`;
}

function buildRewardfulUrl(path: string, params?: URLSearchParams): string {
  const url = new URL(`${REWARDFUL_API_BASE_URL}${path}`);
  params?.forEach((value, key) => {
    if (value.trim()) {
      url.searchParams.append(key, value);
    }
  });
  return url.toString();
}

export function isRewardfulRemoteResource(
  value: string | undefined,
): value is RewardfulRemoteResource {
  return REWARDFUL_REMOTE_RESOURCES.includes(
    value as RewardfulRemoteResource,
  );
}

export async function rewardfulApiRequest<T = unknown>(
  path: string,
  params?: URLSearchParams,
): Promise<RewardfulApiResult<T>> {
  const apiSecret = getRewardfulApiSecret();
  if (!apiSecret) {
    return {
      data: null,
      error: "REWARDFUL_API_SECRET is not configured",
      ok: false,
      status: 503,
    };
  }

  try {
    const response = await fetch(buildRewardfulUrl(path, params), {
      headers: {
        Accept: "application/json",
        Authorization: buildAuthHeader(apiSecret),
      },
      method: "GET",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json()) as T)
      : null;

    return {
      data: payload,
      error: response.ok ? null : `Rewardful API returned ${response.status}`,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Rewardful API request failed",
      ok: false,
      status: 502,
    };
  }
}

export async function listRewardfulRemoteResource(
  resource: RewardfulRemoteResource,
  params?: URLSearchParams,
): Promise<RewardfulApiResult> {
  return rewardfulApiRequest(`/${resource}`, params);
}

export async function getRewardfulApiHealth(): Promise<RewardfulApiHealth> {
  if (!getRewardfulApiSecret()) {
    return {
      configured: false,
      ok: false,
      checks: REWARDFUL_REMOTE_RESOURCES.map((resource) => ({
        error: "REWARDFUL_API_SECRET is not configured",
        ok: false,
        resource,
        status: 503,
      })),
    };
  }

  const params = new URLSearchParams({ limit: "1" });
  const checks = await Promise.all(
    REWARDFUL_REMOTE_RESOURCES.map(async (resource) => {
      const result = await listRewardfulRemoteResource(resource, params);
      return {
        error: result.error,
        ok: result.ok,
        resource,
        status: result.status,
      };
    }),
  );

  return {
    configured: true,
    ok: checks.every((check) => check.ok),
    checks,
  };
}
