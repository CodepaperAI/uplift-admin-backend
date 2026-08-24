import { createHash } from "node:crypto";
import { functions } from "../inngest/client";

type InngestApiEvent = {
  id: string;
  name: string;
  received_at?: string;
  ts?: number;
  environment_id?: string;
  data?: Record<string, unknown>;
};

type InngestApiRun = {
  run_id: string;
  run_started_at?: string;
  ended_at?: string;
  function_id?: string;
  event_id?: string;
  cron?: string;
  status?: string;
};

type InngestEventListResponse = {
  data: InngestApiEvent[];
  metadata?: {
    fetched_at?: string;
    cached_until?: string;
  };
};

type InngestRunResponse = {
  data: InngestApiRun;
  metadata?: {
    fetched_at?: string;
    cached_until?: string;
  };
};

export type InngestFunctionMetric = {
  id: string;
  name: string;
  triggerType: "cron" | "event";
  triggerValue: string;
  nextRunAt: string | null;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  lastTriggerName: string | null;
  lastError: string | null;
};

export type InngestRecentRunMetric = {
  runId: string;
  functionId: string | null;
  functionName: string;
  triggerEventName: string | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cron: string | null;
  error: string | null;
};

export type InngestRecentEventMetric = {
  id: string;
  name: string;
  receivedAt: string | null;
  functionId: string | null;
  runId: string | null;
  status: string | null;
  triggerEventName: string | null;
  error: string | null;
};

export type InngestMetricsPayload = {
  fetchedAt: string;
  summary: {
    totalFunctions: number;
    scheduledFunctions: number;
    eventFunctions: number;
    recentCompletedRuns: number;
    recentFailedRuns: number;
    recentOtherRuns: number;
  };
  scheduledFunctions: InngestFunctionMetric[];
  eventFunctions: InngestFunctionMetric[];
  recentRuns: InngestRecentRunMetric[];
  recentEvents: InngestRecentEventMetric[];
};

type FunctionDefinition = {
  slug: string;
  id: string;
  name: string;
  triggerType: "cron" | "event";
  triggerValue: string;
};

function buildSigningKeyHash(signingKey: string): string {
  const prefix = signingKey.match(/^signkey-[\w]+-/)?.[0] ?? "";
  const raw = signingKey.replace(/^signkey-[\w]+-/, "");
  return `${prefix}${createHash("sha256").update(raw, "hex").digest("hex")}`;
}

async function fetchInngestJson<T>(path: string): Promise<T> {
  const signingKey = process.env.INNGEST_SIGNING_KEY ?? "";
  if (signingKey === "") {
    throw new Error("INNGEST_SIGNING_KEY is not configured.");
  }

  const authToken = buildSigningKeyHash(signingKey);
  const baseUrl = process.env.INNGEST_API_BASE_URL ?? "https://api.inngest.com";
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Inngest API ${path} failed: ${response.status} ${text}`);
  }

  return JSON.parse(text) as T;
}

function getFunctionDefinitions(): FunctionDefinition[] {
  return functions.map((fn) => {
    const opts = (fn as unknown as {
      opts: {
        id: string;
        name?: string | null;
        triggers?: Array<{ cron?: string; event?: string }>;
      };
    }).opts;
    const trigger = opts.triggers?.[0];
    const triggerType = trigger?.cron ? "cron" : "event";
    const triggerValue = trigger?.cron ?? trigger?.event ?? "unknown";

    return {
      slug: fn.id("seo-be"),
      id: opts.id,
      name: opts.name ?? opts.id,
      triggerType,
      triggerValue,
    };
  });
}

function matchesCronValue(value: number, expr: string): boolean {
  if (expr === "*") {
    return true;
  }

  const parts = expr.split(",");
  return parts.some((part) => {
    if (part === "*") {
      return true;
    }
    if (part.startsWith("*/")) {
      const step = Number.parseInt(part.slice(2), 10);
      return Number.isInteger(step) && step > 0 && value % step === 0;
    }
    if (part.includes("-")) {
      const rangeParts = part
        .split("-")
        .map((segment) => Number.parseInt(segment, 10));
      const start = rangeParts[0];
      const end = rangeParts[1];
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return false;
      }
      return value >= (start as number) && value <= (end as number);
    }

    const parsed = Number.parseInt(part, 10);
    return Number.isInteger(parsed) && value === parsed;
  });
}

function matchesCron(date: Date, cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }

  const minuteExpr = fields[0] ?? "*";
  const hourExpr = fields[1] ?? "*";
  const dayExpr = fields[2] ?? "*";
  const monthExpr = fields[3] ?? "*";
  const weekDayExpr = fields[4] ?? "*";
  return (
    matchesCronValue(date.getUTCMinutes(), minuteExpr) &&
    matchesCronValue(date.getUTCHours(), hourExpr) &&
    matchesCronValue(date.getUTCDate(), dayExpr) &&
    matchesCronValue(date.getUTCMonth() + 1, monthExpr) &&
    matchesCronValue(date.getUTCDay(), weekDayExpr)
  );
}

function getNextCronRunAt(
  cron: string,
  from: Date = new Date(),
): string | null {
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let attempts = 0; attempts < 60 * 24 * 365; attempts += 1) {
    if (matchesCron(candidate, cron)) {
      return candidate.toISOString();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return null;
}

function readString(
  value: unknown,
): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizeError(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value) as {
        error?: {
          message?: string;
          error?: string;
          name?: string;
        };
      };
      return (
        parsed.error?.message ??
        parsed.error?.error ??
        parsed.error?.name ??
        value
      );
    } catch {
      return value;
    }
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      readString(record.message) ??
      readString(record.error) ??
      readString(record.name)
    );
  }

  return null;
}

function buildEventMetric(event: InngestApiEvent): InngestRecentEventMetric {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const inngestData =
    data._inngest && typeof data._inngest === "object"
      ? (data._inngest as Record<string, unknown>)
      : null;
  const triggerEvent =
    data.event && typeof data.event === "object"
      ? (data.event as Record<string, unknown>)
      : null;

  return {
    id:
      event.id ??
      `${event.name}-${event.received_at ?? event.ts ?? Math.random().toString(36).slice(2)}`,
    name: event.name,
    receivedAt:
      event.received_at ??
      (typeof event.ts === "number" ? new Date(event.ts).toISOString() : null),
    functionId: readString(data.function_id),
    runId: readString(data.run_id),
    status: readString(inngestData?.status),
    triggerEventName: readString(triggerEvent?.name),
    error: normalizeError(data.error ?? data.result),
  };
}

export async function getInngestMetrics(
  limit: number = 25,
): Promise<InngestMetricsPayload> {
  const functionDefinitions = getFunctionDefinitions();
  const definitionsBySlug = new Map(
    functionDefinitions.map((definition) => [definition.slug, definition]),
  );

  const eventsResponse = await fetchInngestJson<InngestEventListResponse>(
    `/v1/events?limit=${Math.max(limit * 4, 40)}`,
  );
  const eventMetrics = eventsResponse.data.map(buildEventMetric);

  const latestEventByFunction = new Map<string, InngestRecentEventMetric>();
  for (const event of eventMetrics) {
    if (!event.functionId || latestEventByFunction.has(event.functionId)) {
      continue;
    }
    latestEventByFunction.set(event.functionId, event);
  }

  const recentFinishedEvents = Array.from(
    new Map(
      eventMetrics
        .filter(
          (event) =>
            (event.name === "inngest/function.finished" ||
              event.name === "inngest/function.failed") &&
            event.runId !== null,
        )
        .map((event) => [event.runId!, event]),
    ).values(),
  );

  const recentRuns = await Promise.all(
    recentFinishedEvents.slice(0, limit).map(async (event) => {
      try {
        const runResponse = await fetchInngestJson<InngestRunResponse>(
          `/v1/runs/${event.runId}`,
        );
        const run = runResponse.data;
        const definition =
          (event.functionId ? definitionsBySlug.get(event.functionId) : undefined) ??
          null;

        return {
          runId: run.run_id,
          functionId: event.functionId,
          functionName: definition?.name ?? event.functionId ?? "Unknown function",
          triggerEventName: event.triggerEventName,
          status: run.status ?? event.status,
          startedAt: run.run_started_at ?? null,
          endedAt: run.ended_at ?? event.receivedAt,
          cron: run.cron ?? null,
          error: event.error,
        } satisfies InngestRecentRunMetric;
      } catch {
        const definition =
          (event.functionId ? definitionsBySlug.get(event.functionId) : undefined) ??
          null;

        return {
          runId: event.runId!,
          functionId: event.functionId,
          functionName: definition?.name ?? event.functionId ?? "Unknown function",
          triggerEventName: event.triggerEventName,
          status: event.status,
          startedAt: null,
          endedAt: event.receivedAt,
          cron: null,
          error: event.error,
        } satisfies InngestRecentRunMetric;
      }
    }),
  );

  const scheduledFunctions = functionDefinitions
    .filter((definition) => definition.triggerType === "cron")
    .map((definition) => {
      const latestEvent = latestEventByFunction.get(definition.slug) ?? null;
      return {
        id: definition.slug,
        name: definition.name,
        triggerType: definition.triggerType,
        triggerValue: definition.triggerValue,
        nextRunAt: getNextCronRunAt(definition.triggerValue),
        lastRunId: latestEvent?.runId ?? null,
        lastRunStatus: latestEvent?.status ?? null,
        lastRunAt: latestEvent?.receivedAt ?? null,
        lastTriggerName: latestEvent?.triggerEventName ?? null,
        lastError: latestEvent?.error ?? null,
      } satisfies InngestFunctionMetric;
    })
    .sort((left, right) =>
      (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""),
    );

  const eventFunctions = functionDefinitions
    .filter((definition) => definition.triggerType === "event")
    .map((definition) => {
      const latestEvent = latestEventByFunction.get(definition.slug) ?? null;
      return {
        id: definition.slug,
        name: definition.name,
        triggerType: definition.triggerType,
        triggerValue: definition.triggerValue,
        nextRunAt: null,
        lastRunId: latestEvent?.runId ?? null,
        lastRunStatus: latestEvent?.status ?? null,
        lastRunAt: latestEvent?.receivedAt ?? null,
        lastTriggerName: latestEvent?.triggerEventName ?? null,
        lastError: latestEvent?.error ?? null,
      } satisfies InngestFunctionMetric;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const recentCompletedRuns = recentRuns.filter(
    (run) => run.status?.toLowerCase() === "completed",
  ).length;
  const recentFailedRuns = recentRuns.filter(
    (run) => run.status?.toLowerCase() === "failed",
  ).length;

  return {
    fetchedAt:
      eventsResponse.metadata?.fetched_at ?? new Date().toISOString(),
    summary: {
      totalFunctions: functionDefinitions.length,
      scheduledFunctions: scheduledFunctions.length,
      eventFunctions: eventFunctions.length,
      recentCompletedRuns,
      recentFailedRuns,
      recentOtherRuns:
        recentRuns.length - recentCompletedRuns - recentFailedRuns,
    },
    scheduledFunctions,
    eventFunctions,
    recentRuns,
    recentEvents: eventMetrics.slice(0, limit),
  };
}
