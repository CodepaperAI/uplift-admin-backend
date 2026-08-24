import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { prisma } from "../config/db.config";
import { canEnterCommandPanel, isCommandPanelRole } from "../command/access-control";
import { consumeSensitiveRateLimit } from "../utils/tenant-response-cache";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  ADMIN_AUTH_COOKIE_PREFIX,
  ADMIN_AUTH_SURFACE,
  adminTrustedOrigins,
  internalAuthSecret,
  internalPasswordError,
  INTERNAL_PASSWORD_MAX_LENGTH,
  INTERNAL_PASSWORD_MIN_LENGTH,
  isMfaVerificationPath,
  requireSuperadminMfa,
} from "./admin-auth-policy";

const ADMIN_AUTH_BASE_PATH = "/api/v1/auth/admin";
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

const adminAuthRateLimitStorage = {
  async get() {
    return undefined;
  },
  async set() {
    // Better Auth uses the atomic consume method below when it is present.
  },
  async consume(key: string, rule: { window: number; max: number }) {
    const result = await consumeSensitiveRateLimit({
      namespace: "admin-auth",
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

export const adminAuth = betterAuth({
  appName: "Uplift AI Command",
  baseURL: backendOrigin(),
  basePath: ADMIN_AUTH_BASE_PATH,
  secret: internalAuthSecret(),
  logger: {
    level: "error",
    disableColors: true,
    log: (_level, message) => {
      // A disabled Command user intentionally makes the session-create hook
      // return false. Do not let credential stuffing turn that expected denial
      // into unbounded error-log I/O.
      if (message === "Failed to create session") return;
      console.error(`[admin-auth] ${message}`);
    },
  },
  trustedOrigins: adminTrustedOrigins(),
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    autoSignIn: false,
    minPasswordLength: INTERNAL_PASSWORD_MIN_LENGTH,
    maxPasswordLength: INTERNAL_PASSWORD_MAX_LENGTH,
  },
  user: {
    additionalFields: {
      role: { type: "string", required: true, input: false },
      commandPanelEnabled: {
        type: "boolean",
        required: true,
        input: false,
        defaultValue: false,
      },
    },
  },
  session: {
    expiresIn: ADMIN_SESSION_MAX_AGE_SECONDS,
    updateAge: 24 * 60 * 60,
    freshAge: 5 * 60,
    additionalFields: {
      surface: {
        type: "string",
        required: true,
        input: false,
        defaultValue: ADMIN_AUTH_SURFACE,
      },
      mfaVerifiedAt: { type: "date", required: false, input: false },
    },
  },
  advanced: {
    cookiePrefix: ADMIN_AUTH_COOKIE_PREFIX,
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
    customStorage: adminAuthRateLimitStorage,
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 15 * 60, max: 3 },
      "/reset-password": { window: 15 * 60, max: 5 },
      "/change-password": { window: 15 * 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 5 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      const password =
        context.path === "/sign-up/email"
          ? context.body?.password
          : context.path === "/change-password" ||
              context.path === "/set-password" ||
              context.path === "/reset-password"
            ? context.body?.newPassword
            : undefined;
      if (password === undefined) return;
      const message = internalPasswordError(password);
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
        before: async (session, context) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { role: true, commandPanelEnabled: true },
          });
          if (
            !user ||
            !isCommandPanelRole(user.role) ||
            !canEnterCommandPanel(user)
          ) {
            return false;
          }
          return {
            data: {
              ...session,
              surface: ADMIN_AUTH_SURFACE,
              mfaVerifiedAt: isMfaVerificationPath(context?.path)
                ? new Date()
                : null,
            },
          };
        },
      },
    },
  },
  plugins: requireSuperadminMfa()
    ? [
        twoFactor({
          issuer: "Uplift AI Command",
          twoFactorCookieMaxAge: 10 * 60,
          trustDeviceMaxAge: 0,
        }),
      ]
    : [],
});

export const ADMIN_AUTH_PATH = ADMIN_AUTH_BASE_PATH;
