import type { IncomingHttpHeaders } from "node:http";

function coreBackendOrigin(): string {
  const configured =
    process.env.CORE_BACKEND_URL?.trim() || "https://api.upliftai.co";
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("CORE_BACKEND_URL must use HTTPS in production");
  }
  return parsed.origin;
}

export async function getCoreInngestMetrics(input: {
  headers: IncomingHttpHeaders;
  limit: number;
}): Promise<unknown> {
  const cookie = input.headers.cookie;
  if (!cookie) throw new Error("Admin session cookie is required");

  const url = new URL(
    "/api/v1/superadmin/agencies/metrics/inngest",
    coreBackendOrigin(),
  );
  url.searchParams.set("limit", String(input.limit));

  const response = await fetch(url, {
    headers: {
      cookie,
      accept: "application/json",
      "x-admin-api-relay": "inngest-metrics",
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || !body?.success) {
    throw new Error(`Core Inngest metrics relay failed with ${response.status}`);
  }
  return body.data;
}
