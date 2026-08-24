export type GMBConnectionHealthState =
  | "disconnected"
  | "pending_location_selection"
  | "healthy"
  | "sync_required"
  | "stale"
  | "sync_error"
  | "reconnect_required";

export type GMBConnectionHealth = {
  state: GMBConnectionHealthState;
  configured: boolean;
  operational: boolean;
  lastSyncAt: string | null;
  checkedAt: string;
};

export function getPublicGmbConnectionIssue(
  state: GMBConnectionHealth["state"],
): string | null {
  switch (state) {
    case "pending_location_selection":
      return "Finish selecting a Google Business Profile location.";
    case "sync_required":
      return "Run the first Google Business Profile sync.";
    case "stale":
      return "Google Business Profile data is overdue for a refresh.";
    case "sync_error":
      return "Google Business Profile could not be synced. Try again.";
    case "reconnect_required":
      return "Reconnect Google Business Profile to renew access.";
    case "disconnected":
    case "healthy":
      return null;
  }
}

const DEFAULT_STALE_AFTER_HOURS = 36;
const MIN_STALE_AFTER_HOURS = 6;
const MAX_STALE_AFTER_HOURS = 7 * 24;

function staleAfterHoursFromEnv(): number {
  const parsed = Number.parseInt(
    process.env.GMB_CONNECTION_STALE_AFTER_HOURS ?? "",
    10,
  );
  if (!Number.isFinite(parsed)) return DEFAULT_STALE_AFTER_HOURS;
  return Math.min(
    MAX_STALE_AFTER_HOURS,
    Math.max(MIN_STALE_AFTER_HOURS, parsed),
  );
}

function requiresReconnect(lastSyncError: string | null | undefined): boolean {
  const normalized = lastSyncError?.trim().toLowerCase();
  if (!normalized) return false;

  return [
    "reconnect required",
    "invalid_grant",
    "invalid or revoked",
    "token has been expired or revoked",
  ].some((marker) => normalized.includes(marker));
}

export function assessGmbConnectionHealth(
  input: {
    accessTokenPresent: boolean;
    isActive: boolean;
    accountId: string | null | undefined;
    locationId: string | null | undefined;
    lastSyncAt: Date | string | null | undefined;
    lastSyncError: string | null | undefined;
  },
  options?: {
    now?: Date;
    staleAfterHours?: number;
  },
): GMBConnectionHealth {
  const now = options?.now ?? new Date();
  const checkedAt = now.toISOString();
  const lastSyncDate = input.lastSyncAt
    ? new Date(input.lastSyncAt)
    : null;
  const validLastSyncDate =
    lastSyncDate && Number.isFinite(lastSyncDate.getTime())
      ? lastSyncDate
      : null;
  const lastSyncAt = validLastSyncDate?.toISOString() ?? null;
  const configured = Boolean(
    input.isActive && input.accountId && input.locationId,
  );

  if (!input.accessTokenPresent) {
    return {
      state: "disconnected",
      configured: false,
      operational: false,
      lastSyncAt,
      checkedAt,
    };
  }

  if (requiresReconnect(input.lastSyncError)) {
    return {
      state: "reconnect_required",
      configured,
      operational: false,
      lastSyncAt,
      checkedAt,
    };
  }

  if (!configured) {
    return {
      state: "pending_location_selection",
      configured: false,
      operational: false,
      lastSyncAt,
      checkedAt,
    };
  }

  if (input.lastSyncError?.trim()) {
    return {
      state: "sync_error",
      configured: true,
      operational: false,
      lastSyncAt,
      checkedAt,
    };
  }

  if (!validLastSyncDate) {
    return {
      state: "sync_required",
      configured: true,
      operational: false,
      lastSyncAt: null,
      checkedAt,
    };
  }

  const staleAfterHours = Math.min(
    MAX_STALE_AFTER_HOURS,
    Math.max(
      MIN_STALE_AFTER_HOURS,
      options?.staleAfterHours ?? staleAfterHoursFromEnv(),
    ),
  );
  const ageMilliseconds = now.getTime() - validLastSyncDate.getTime();
  if (ageMilliseconds > staleAfterHours * 60 * 60 * 1000) {
    return {
      state: "stale",
      configured: true,
      operational: false,
      lastSyncAt,
      checkedAt,
    };
  }

  return {
    state: "healthy",
    configured: true,
    operational: true,
    lastSyncAt,
    checkedAt,
  };
}
