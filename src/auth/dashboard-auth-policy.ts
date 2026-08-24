import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const DASHBOARD_AUTH_PATH = "/api/auth";
export const DASHBOARD_AUTH_SURFACE = "dashboard";
export const DASHBOARD_PASSWORD_MIN_LENGTH = 15;
export const DASHBOARD_PASSWORD_MAX_LENGTH = 128;
export const DASHBOARD_EMAIL_VERIFICATION_POLICY = Object.freeze({
  requireEmailVerification: false,
  sendOnSignUp: true,
  sendOnSignIn: false,
});

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const COMMON_PASSWORDS = new Set([
  "123456789012345",
  "1234567890123456",
  "adminadminadmin",
  "iloveyouiloveyou",
  "letmeinletmein",
  "passwordpassword",
  "password123456",
  "passwordpassword9!",
  "qwertyqwertyqwerty",
  "upliftaiupliftai",
]);

function httpOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function configuredOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((candidate) => httpOrigin(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
}

export function dashboardFrontendOrigin(): string {
  return (
    httpOrigin(process.env.DASHBOARD_URL) ??
    httpOrigin(process.env.FRONTEND_URL) ??
    httpOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    (process.env.NODE_ENV === "production"
      ? "https://dashboard.upliftai.co"
      : "http://localhost:3001")
  );
}

export function dashboardTrustedOrigins(): string[] {
  const fixed = [
    dashboardFrontendOrigin(),
    "http://localhost:3001",
    "http://dashboard.localhost:3001",
    "http://localhost:3004",
    "http://uplift.localhost:3002",
    "https://dashboard.upliftai.co",
    "https://upliftai.co",
    "https://www.upliftai.co",
    "https://dashboard.dev.upliftai.co",
    "https://app.dev.upliftai.co",
  ];
  return [
    ...new Set([
      ...fixed,
      ...configuredOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
      ...configuredOrigins(process.env.CORS_ALLOWED_ORIGINS),
    ]),
  ];
}

export function dashboardAuthIpHeaders(value = process.env.BETTER_AUTH_IP_HEADERS): string[] {
  const configured = (value ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  // Same-origin browser auth reaches the backend through the Next.js relay,
  // which forwards one validated client address in X-Forwarded-For.
  return configured.length > 0 ? configured : ["x-forwarded-for"];
}

export function dashboardPasswordError(password: unknown): string | null {
  if (typeof password !== "string" || !password) return "Enter your password.";
  if (password.length < DASHBOARD_PASSWORD_MIN_LENGTH) {
    return `Password must contain at least ${DASHBOARD_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > DASHBOARD_PASSWORD_MAX_LENGTH) {
    return `Password must contain no more than ${DASHBOARD_PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!password.trim()) return "Password cannot contain only spaces.";
  if (CONTROL_CHARACTER_PATTERN.test(password)) {
    return "Password cannot contain control characters.";
  }
  if (COMMON_PASSWORDS.has(password.normalize("NFKC").toLowerCase())) {
    return "Password is too common. Choose a unique passphrase.";
  }
  return null;
}

export function dashboardFullNameError(value: unknown): string | null {
  if (typeof value !== "string") return "Enter your full name.";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > 161 ||
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    !/\p{L}/u.test(normalized)
  ) {
    return "Enter a valid full name.";
  }
  return null;
}

export function dashboardPhoneError(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Enter your phone number.";
  }
  const normalized = value.trim();
  const phone = parsePhoneNumberFromString(normalized);
  return phone?.isValid() && phone.number === normalized
    ? null
    : "Enter a valid phone number including its country code.";
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Keep local auth links usable during local development, while ensuring a
 * production process can never emit a loopback URL in an email.
 */
export function canonicalAuthEmailUrl(value: string): string {
  const parsed = new URL(value);
  if (!isLocalHostname(parsed.hostname)) return parsed.toString();

  const configuredFrontend = new URL(dashboardFrontendOrigin());
  const isLocalDevelopment =
    process.env.NODE_ENV !== "production" &&
    isLocalHostname(configuredFrontend.hostname);

  if (!isLocalDevelopment) {
    const production = new URL("https://dashboard.upliftai.co");
    parsed.protocol = production.protocol;
    parsed.hostname = production.hostname;
    parsed.port = "";
  }
  return parsed.toString();
}
