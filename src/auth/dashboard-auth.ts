import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { prisma } from "../config/db.config";
import { EmailService } from "../services/email.service";
import { syncSignupToGhl } from "../services/ghl-signup-sync.service";
import { consumeSensitiveRateLimit } from "../utils/tenant-response-cache";
import {
  canonicalAuthEmailUrl,
  DASHBOARD_AUTH_PATH,
  DASHBOARD_AUTH_SURFACE,
  DASHBOARD_EMAIL_VERIFICATION_POLICY,
  DASHBOARD_PASSWORD_MAX_LENGTH,
  DASHBOARD_PASSWORD_MIN_LENGTH,
  dashboardFrontendOrigin,
  dashboardAuthIpHeaders,
  dashboardFullNameError,
  dashboardPasswordError,
  dashboardPhoneError,
  dashboardTrustedOrigins,
} from "./dashboard-auth-policy";

const isProduction = process.env.NODE_ENV === "production";
const emailService = new EmailService();
const dashboardAuthRateLimitStorage = {
  async get() {
    return undefined;
  },
  async set() {
    // Better Auth uses the atomic consume operation when provided.
  },
  async consume(key: string, rule: { window: number; max: number }) {
    const result = await consumeSensitiveRateLimit({
      namespace: "dashboard-auth",
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

async function sendPasswordResetEmail(input: {
  user: { email: string; name: string };
  url: string;
}) {
  const result = await emailService.sendPasswordResetEmail({
    userEmail: input.user.email,
    userName: input.user.name?.trim() || "there",
    resetUrl: canonicalAuthEmailUrl(input.url),
  });
  if (!result.success) throw new Error("Password reset email could not be sent");
}

async function sendVerificationEmail(input: {
  user: { email: string; name: string };
  url: string;
}) {
  const result = await emailService.sendChangeEmailVerificationEmail({
    userEmail: input.user.email,
    userName: input.user.name?.trim() || "there",
    verificationUrl: canonicalAuthEmailUrl(input.url),
  });
  if (!result.success) throw new Error("Verification email could not be sent");
}

export const dashboardAuth = betterAuth({
  appName: "Uplift AI",
  baseURL: dashboardFrontendOrigin(),
  basePath: DASHBOARD_AUTH_PATH,
  trustedOrigins: dashboardTrustedOrigins(),
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  logger: {
    level: "error",
    disableColors: true,
  },
  advanced: {
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
    },
    ipAddress: {
      ipAddressHeaders: dashboardAuthIpHeaders(),
      ipv6Subnet: 64,
    },
  },
  rateLimit: {
    enabled: true,
    customStorage: dashboardAuthRateLimitStorage,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60 * 60, max: 3 },
      "/request-password-reset": { window: 15 * 60, max: 3 },
      "/reset-password": { window: 15 * 60, max: 5 },
      "/send-verification-email": { window: 15 * 60, max: 3 },
      "/change-password": { window: 15 * 60, max: 5 },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 60,
    additionalFields: {
      surface: {
        type: "string",
        required: true,
        input: false,
        defaultValue: DASHBOARD_AUTH_SURFACE,
      },
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
      if (password !== undefined) {
        const message = dashboardPasswordError(password);
        if (message) {
          throw new APIError("BAD_REQUEST", {
            code: "INVALID_PASSWORD",
            message,
          });
        }
      }
      if (context.path !== "/sign-up/email") return;
      const nameError = dashboardFullNameError(context.body?.name);
      if (nameError) {
        throw new APIError("BAD_REQUEST", {
          code: "INVALID_NAME",
          message: nameError,
        });
      }
      const phoneError = dashboardPhoneError(context.body?.phone);
      if (phoneError) {
        throw new APIError("BAD_REQUEST", {
          code: "INVALID_PHONE_NUMBER",
          message: phoneError,
        });
      }
    }),
  },
  plugins: [
    haveIBeenPwned({
      paths: [
        "/sign-up/email",
        "/change-password",
        "/set-password",
        "/reset-password",
      ],
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        async after(user) {
          const result = await syncSignupToGhl(user);
          if (result.status === "failed") {
            console.error("[dashboard-auth] Signup sync failed");
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => ({
          data: { ...session, surface: DASHBOARD_AUTH_SURFACE },
        }),
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification:
      DASHBOARD_EMAIL_VERIFICATION_POLICY.requireEmailVerification,
    minPasswordLength: DASHBOARD_PASSWORD_MIN_LENGTH,
    maxPasswordLength: DASHBOARD_PASSWORD_MAX_LENGTH,
    resetPasswordTokenExpiresIn: 15 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: sendPasswordResetEmail,
  },
  emailVerification: {
    sendOnSignUp: DASHBOARD_EMAIL_VERIFICATION_POLICY.sendOnSignUp,
    sendOnSignIn: DASHBOARD_EMAIL_VERIFICATION_POLICY.sendOnSignIn,
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60,
    sendVerificationEmail,
  },
  user: {
    additionalFields: {
      phone: { type: "string", required: false, input: true },
    },
    changeEmail: { enabled: true },
  },
  account: {
    encryptOAuthTokens: true,
    storeStateStrategy: "database",
    accountLinking: {
      requireLocalEmailVerified: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
});

export { DASHBOARD_AUTH_PATH };
