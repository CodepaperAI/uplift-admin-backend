import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prisma } from "../config/db.config";
import { consumeSensitiveRateLimit } from "../utils/tenant-response-cache";
import {
  SALES_AUTH_COOKIE_PREFIX,
  SALES_AUTH_PATH,
  SALES_AUTH_SURFACE,
  SALES_PASSWORD_MAX_LENGTH,
  SALES_PASSWORD_MIN_LENGTH,
  salesAuthSecret,
  salesPasswordError,
  salesTrustedOrigins,
} from "./sales-auth-policy";

const isProduction = process.env.NODE_ENV === "production";

function backendOrigin(): string {
  const configured = process.env.BACKEND_URL?.trim() || "http://localhost:3000";
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("BACKEND_URL must use HTTP or HTTPS");
    }
    return parsed.origin;
  } catch {
    if (isProduction) throw new Error("BACKEND_URL is invalid");
    return "http://localhost:3000";
  }
}

const salesAuthRateLimitStorage = {
  async get() {
    return undefined;
  },
  async set() {
    // Better Auth uses the atomic consume operation below when present.
  },
  async consume(key: string, rule: { window: number; max: number }) {
    const result = await consumeSensitiveRateLimit({
      namespace: "sales-auth",
      discriminator: key,
      limit: rule.max,
      windowSeconds: rule.window,
    });
    return {
      allowed: result.allowed,
      retryAfter: result.allowed ? null : result.retryAfterSeconds,
    };
  },
};

export const salesAuth = betterAuth({
  appName: "Uplift AI Sales",
  baseURL: backendOrigin(),
  basePath: SALES_AUTH_PATH,
  secret: salesAuthSecret(),
  trustedOrigins: salesTrustedOrigins(),
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  logger: {
    level: "error",
    disableColors: true,
    log: (_level, message) => {
      if (message === "Failed to create session") return;
      console.error(`[sales-auth] ${message}`);
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    autoSignIn: false,
    minPasswordLength: SALES_PASSWORD_MIN_LENGTH,
    maxPasswordLength: SALES_PASSWORD_MAX_LENGTH,
  },
  session: {
    expiresIn: 8 * 60 * 60,
    updateAge: 15 * 60,
    freshAge: 15 * 60,
    additionalFields: {
      surface: {
        type: "string",
        required: true,
        input: false,
        defaultValue: SALES_AUTH_SURFACE,
      },
    },
  },
  advanced: {
    cookiePrefix: SALES_AUTH_COOKIE_PREFIX,
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
    },
  },
  rateLimit: {
    enabled: true,
    customStorage: salesAuthRateLimitStorage,
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 15 * 60, max: 3 },
      "/reset-password": { window: 15 * 60, max: 5 },
      "/change-password": { window: 15 * 60, max: 5 },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      const password =
        context.path === "/change-password" ||
        context.path === "/set-password" ||
        context.path === "/reset-password"
          ? context.body?.newPassword
          : undefined;
      if (password === undefined) return;
      const message = salesPasswordError(password);
      if (message) {
        throw new APIError("BAD_REQUEST", {
          code: "INVALID_PASSWORD",
          message,
        });
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { role: true, commandPanelEnabled: true },
          });
          if (user?.role !== "SALES" || !user.commandPanelEnabled) {
            return false;
          }
          return {
            data: { ...session, surface: SALES_AUTH_SURFACE },
          };
        },
      },
    },
  },
});
