export const SALES_AUTH_PATH = "/api/v1/auth/sales";
export const SALES_AUTH_SURFACE = "sales";
export const SALES_AUTH_COOKIE_PREFIX = "uplift-sales";
export const SALES_PASSWORD_MIN_LENGTH = 12;
export const SALES_PASSWORD_MAX_LENGTH = 128;

export function resolveSalesAuthSecret(
  rawSecret: string | undefined,
  environment: string | undefined,
): string {
  const configured = rawSecret?.trim() ?? "";
  if (Buffer.byteLength(configured, "utf8") >= 32) return configured;
  if (environment === "production") {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 bytes");
  }
  return "uplift-sales-local-only-auth-secret-32-bytes";
}

export function salesAuthSecret(): string {
  return resolveSalesAuthSecret(
    process.env.BETTER_AUTH_SECRET,
    process.env.NODE_ENV,
  );
}

export function salesPasswordError(value: unknown): string | null {
  if (typeof value !== "string") return "Password is required.";
  if (
    value.length < SALES_PASSWORD_MIN_LENGTH ||
    value.length > SALES_PASSWORD_MAX_LENGTH
  ) {
    return `Password must be between ${SALES_PASSWORD_MIN_LENGTH} and ${SALES_PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    return "Password must contain uppercase, lowercase, and numeric characters.";
  }
  if (!/[^A-Za-z0-9]/.test(value)) {
    return "Password must contain a symbol.";
  }
  return null;
}

export function salesTrustedOrigins(): string[] {
  const candidates = [
    "http://localhost:3003",
    "https://sales.upliftai.co",
    "https://sales-staging.upliftai.co",
    "https://sales-dev.upliftai.co",
    "https://sales.dev.upliftai.co",
    process.env.SALES_FRONTEND_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        origins.add(parsed.origin);
      }
    } catch {
      // Optional malformed deployment origins are ignored.
    }
  }
  return [...origins];
}
