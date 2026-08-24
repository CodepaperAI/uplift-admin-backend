const MIN_MFA_ASSURANCE_SECONDS = 5 * 60;
const MAX_MFA_ASSURANCE_SECONDS = 24 * 60 * 60;
const DEFAULT_MFA_ASSURANCE_SECONDS = 12 * 60 * 60;

// Browsers cap persistent cookies at roughly 400 days. Better Auth refreshes
// this expiry while the admin portal is in use, so Command sessions no longer
// have an application-level idle timeout while still remaining revocable.
export const ADMIN_SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export const INTERNAL_PASSWORD_MIN_LENGTH = 12;
export const INTERNAL_PASSWORD_MAX_LENGTH = 128;
export const ADMIN_AUTH_SURFACE = "admin";
export const ADMIN_AUTH_COOKIE_PREFIX = "uplift-command";

export function adminTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const candidates = [
    "http://localhost:3002",
    "https://admin.upliftai.co",
    "https://uplift-ai-admin.vercel.app",
    "https://admin-staging.upliftai.co",
    "https://admin-dev.upliftai.co",
    "https://admin.dev.upliftai.co",
    env.ADMIN_FRONTEND_URL,
    env.COMMAND_FRONTEND_URL,
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
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
      // Fixed production/local origins remain available when optional values
      // are malformed.
    }
  }
  return [...origins];
}

export function commandMfaAssuranceMaxAgeSeconds(
  raw = process.env.COMMAND_MFA_ASSURANCE_MAX_AGE_SECONDS,
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_MFA_ASSURANCE_SECONDS;
  return Math.min(
    MAX_MFA_ASSURANCE_SECONDS,
    Math.max(MIN_MFA_ASSURANCE_SECONDS, parsed),
  );
}

export function requireSuperadminMfa(
  rawValue = process.env.COMMAND_REQUIRE_SUPERADMIN_MFA,
  _environment = process.env.NODE_ENV,
): boolean {
  const configured = rawValue?.trim().toLowerCase();
  return configured === "true";
}

export function resolveInternalAuthSecret(
  rawSecret: string | undefined,
  environment: string | undefined,
): string {
  const configured = rawSecret?.trim() ?? "";
  if (Buffer.byteLength(configured, "utf8") >= 32) return configured;
  if (environment === "production") {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 bytes");
  }
  return "uplift-command-local-only-auth-secret-32-bytes";
}

export function internalAuthSecret(): string {
  return resolveInternalAuthSecret(
    process.env.BETTER_AUTH_SECRET,
    process.env.NODE_ENV,
  );
}

export function internalPasswordError(value: unknown): string | null {
  if (typeof value !== "string") return "Password is required.";
  if (
    value.length < INTERNAL_PASSWORD_MIN_LENGTH ||
    value.length > INTERNAL_PASSWORD_MAX_LENGTH
  ) {
    return `Password must be between ${INTERNAL_PASSWORD_MIN_LENGTH} and ${INTERNAL_PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    return "Password must contain uppercase, lowercase, and numeric characters.";
  }
  if (!/[^A-Za-z0-9]/.test(value)) {
    return "Password must contain a symbol.";
  }
  return null;
}

export function isMfaVerificationPath(path: string | undefined): boolean {
  return (
    path === "/two-factor/verify-totp" ||
    path === "/two-factor/verify-backup-code" ||
    path === "/two-factor/verify-otp"
  );
}

export function isCurrentMfaAssurance(
  value: unknown,
  now = Date.now(),
  maxAgeSeconds = commandMfaAssuranceMaxAgeSeconds(),
): boolean {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp > now + 30_000) return false;
  return now - timestamp <= maxAgeSeconds * 1000;
}
