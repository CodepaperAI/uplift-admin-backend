export const ADMIN_API_ROUTES = Object.freeze([
  "/api/v1/auth/admin",
  "/api/v1/command",
  "/api/v1/superadmin/agencies",
]);

function normalizeOrigin(value?: string | null): string | null {
  const origin = value?.trim().replace(/^"+|"+$/g, "");
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

export function configuredCorsOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Array.from(
    new Set(
      [
        "http://localhost:3002",
        "https://admin.upliftai.co",
        "https://uplift-ai-admin.vercel.app",
        "https://admin-staging.upliftai.co",
        "https://admin-dev.upliftai.co",
        "https://admin.dev.upliftai.co",
        normalizeOrigin(env.ADMIN_FRONTEND_URL),
        normalizeOrigin(env.COMMAND_FRONTEND_URL),
        ...(env.CORS_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((origin) => normalizeOrigin(origin)),
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  );
}
