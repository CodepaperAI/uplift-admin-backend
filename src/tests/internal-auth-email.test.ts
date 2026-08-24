import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { requireInternalAuthEmailSecret } from "../middleware/require-internal-secret";

const ORIGINAL_INTERNAL_AUTH_EMAIL_SECRET =
  process.env.INTERNAL_AUTH_EMAIL_SECRET;
const ORIGINAL_INTERNAL_BILLING_SECRET = process.env.INTERNAL_BILLING_SECRET;
const ORIGINAL_BACKEND_AUTH_SECRET = process.env.BACKEND_AUTH_SECRET;

const sendPasswordResetEmailMock = mock(async () => ({
  success: true,
  emailId: "reset-email-id",
}));

const sendChangeEmailVerificationEmailMock = mock(async () => ({
  success: true,
  emailId: "verify-email-id",
}));

mock.module("../services/email.service", () => ({
  EmailService: class {
    sendPasswordResetEmail = sendPasswordResetEmailMock;
    sendChangeEmailVerificationEmail =
      sendChangeEmailVerificationEmailMock;
  },
}));

describe("internal auth email routes", () => {
  let InternalAuthEmailRouter: typeof import("../routes/internal-auth-email.routes").default;
  let sendPasswordResetEmailInternal: typeof import("../controllers/internal-auth-email.controller").sendPasswordResetEmailInternal;
  let sendChangeEmailVerificationEmailInternal: typeof import("../controllers/internal-auth-email.controller").sendChangeEmailVerificationEmailInternal;

  beforeAll(async () => {
    ({ default: InternalAuthEmailRouter } = await import(
      "../routes/internal-auth-email.routes"
    ));
    ({
      sendPasswordResetEmailInternal,
      sendChangeEmailVerificationEmailInternal,
    } = await import("../controllers/internal-auth-email.controller"));
  });

  beforeEach(() => {
    delete process.env.INTERNAL_AUTH_EMAIL_SECRET;
    delete process.env.INTERNAL_BILLING_SECRET;
    process.env.BACKEND_AUTH_SECRET = "shared-secret";

    sendPasswordResetEmailMock.mockClear();
    sendChangeEmailVerificationEmailMock.mockClear();
  });

  afterEach(() => {
    process.env.INTERNAL_AUTH_EMAIL_SECRET =
      ORIGINAL_INTERNAL_AUTH_EMAIL_SECRET;
    process.env.INTERNAL_BILLING_SECRET = ORIGINAL_INTERNAL_BILLING_SECRET;
    process.env.BACKEND_AUTH_SECRET = ORIGINAL_BACKEND_AUTH_SECRET;
  });

  it("mounts internal secret middleware before auth email routes", () => {
    const stack = (InternalAuthEmailRouter as unknown as {
      stack?: Array<{
        handle?: unknown;
        route?: { path?: string };
      }>;
    }).stack;

    expect(Array.isArray(stack)).toBe(true);
    expect(stack?.[0]?.handle).toBe(requireInternalAuthEmailSecret);
    expect(stack?.slice(1).map((layer) => layer.route?.path)).toEqual([
      "/password-reset",
      "/change-email-verification",
    ]);
  });

  it("does not accept the backend auth secret as an internal webhook secret", () => {
    let nextCalled = false;
    let statusCode = 0;
    const req = {
      headers: {
        "x-internal-secret": "shared-secret",
      },
    } as unknown as Parameters<typeof requireInternalAuthEmailSecret>[0];
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Parameters<typeof requireInternalAuthEmailSecret>[1];

    requireInternalAuthEmailSecret(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(503);
  });

  it("accepts only the dedicated strong auth-email secret", () => {
    const secret = "dedicated-internal-secret-at-least-32-bytes";
    process.env.INTERNAL_AUTH_EMAIL_SECRET = secret;
    process.env.INTERNAL_BILLING_SECRET =
      "different-purpose-secret-at-least-32-bytes";
    let nextCalled = false;
    const req = {
      headers: { "x-internal-secret": secret },
    } as unknown as Parameters<typeof requireInternalAuthEmailSecret>[0];
    const res = {
      status: () => res,
      json: () => res,
    } as unknown as Parameters<typeof requireInternalAuthEmailSecret>[1];

    requireInternalAuthEmailSecret(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("rejects a valid secret issued for another internal capability", () => {
    process.env.INTERNAL_AUTH_EMAIL_SECRET =
      "auth-email-purpose-secret-at-least-32-bytes";
    const billingSecret = "billing-purpose-secret-at-least-32-bytes";
    process.env.INTERNAL_BILLING_SECRET = billingSecret;
    let nextCalled = false;
    let statusCode = 0;
    const req = {
      headers: { "x-internal-secret": billingSecret },
    } as unknown as Parameters<typeof requireInternalAuthEmailSecret>[0];
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Parameters<typeof requireInternalAuthEmailSecret>[1];

    requireInternalAuthEmailSecret(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(401);
  });

  it("sends password reset emails through the email service", async () => {
    const req = {
      body: {
        userEmail: "user@example.com",
        userName: "Jane Doe",
        resetUrl: "https://app.example.com/reset-password?token=abc",
      },
    } as any;

    let statusCode = 200;
    let jsonBody: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        jsonBody = payload;
        return this;
      },
    } as any;

    await sendPasswordResetEmailInternal(req, res);

    expect(sendPasswordResetEmailMock).toHaveBeenCalledWith({
      userEmail: "user@example.com",
      userName: "Jane Doe",
      resetUrl: "https://app.example.com/reset-password?token=abc",
    });
    expect(statusCode).toBe(200);
    expect(jsonBody).toMatchObject({
      success: true,
      message: "Password reset email sent successfully",
    });
  });

  it("sends verification emails through the email service", async () => {
    const req = {
      body: {
        userEmail: "new@example.com",
        userName: "Jane Doe",
        verificationUrl: "https://app.example.com/verify-email?token=abc",
      },
    } as any;

    let statusCode = 200;
    let jsonBody: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        jsonBody = payload;
        return this;
      },
    } as any;

    await sendChangeEmailVerificationEmailInternal(req, res);

    expect(sendChangeEmailVerificationEmailMock).toHaveBeenCalledWith({
      userEmail: "new@example.com",
      userName: "Jane Doe",
      verificationUrl: "https://app.example.com/verify-email?token=abc",
    });
    expect(statusCode).toBe(200);
    expect(jsonBody).toMatchObject({
      success: true,
      message: "Verification email sent successfully",
    });
  });
});
