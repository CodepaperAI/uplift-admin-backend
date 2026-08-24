import { afterEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { createContentApprovalNotificationFunctions } from "../inngest/content-approval-notifications";
import {
  contentApprovalReviewUrl,
  sendApprovalReadyNotification,
} from "../services/content-approval-notification.service";
import { generateContentApprovalReadyEmailText } from "../utils/email-templates";

const originalNodeEnv = process.env.NODE_ENV;
const originalDashboardUrl = process.env.DASHBOARD_URL;
const originalFrontendUrl = process.env.FRONTEND_URL;
const originalNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  restoreEnv("NODE_ENV", originalNodeEnv);
  restoreEnv("DASHBOARD_URL", originalDashboardUrl);
  restoreEnv("FRONTEND_URL", originalFrontendUrl);
  restoreEnv("NEXT_PUBLIC_APP_URL", originalNextPublicAppUrl);
});

function useProductionDashboardEnvironment() {
  process.env.NODE_ENV = "production";
  process.env.DASHBOARD_URL = "https://dashboard.upliftai.co";
}

function socialRun(approvalRequired = true) {
  return {
    id: "run-1",
    status: "COMPLETE",
    socialTopicPlanId: "topic-1",
    approvalEmailSentAt: null,
    business: {
      businessName: "Example Studio",
      User: { email: "owner@example.com", name: "Alex" },
      socialAutomationSettings: { approvalRequired },
    },
  };
}

function gmbSuggestion() {
  return {
    id: "suggestion-1",
    status: "PENDING",
    approvalEmailSentAt: null,
    business: {
      businessName: "Example Studio",
      User: { email: "owner@example.com", name: "Alex" },
      GoogleMyBusiness: { postAutomationMode: "approval_required" },
    },
  };
}

describe("content approval notifications", () => {
  test("sends one social approval email with a direct review link", async () => {
    useProductionDashboardEnvironment();
    const claims: any[] = [];
    const sent: any[] = [];
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => socialRun(),
        updateMany: async (input: any) => {
          claims.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const sender = {
      sendContentApprovalReadyEmail: async (input: any) => {
        sent.push(input);
        return { emailId: "email-1", success: true };
      },
    };

    const result = await sendApprovalReadyNotification(
      { kind: "social", contentId: "run-1" },
      prisma,
      sender,
    );

    expect(result.status).toBe("sent");
    expect(claims).toHaveLength(2);
    expect(claims[0].data.approvalEmailClaimedAt).toBeInstanceOf(Date);
    expect(claims[1].data).toMatchObject({ approvalEmailClaimedAt: null });
    expect(claims[1].data.approvalEmailSentAt).toBeInstanceOf(Date);
    expect(sent).toEqual([
      expect.objectContaining({
        userEmail: "owner@example.com",
        contentLabel: "social media",
        reviewUrl: "https://dashboard.upliftai.co/dashboard/social/posts/run-1",
        idempotencyKey: "approval-ready-social-run-1",
      }),
    ]);
  });

  test("does not email a social workspace in auto-publish mode", async () => {
    let sends = 0;
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => socialRun(false),
        updateMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const sender = {
      sendContentApprovalReadyEmail: async () => {
        sends += 1;
        return { emailId: "email-1", success: true };
      },
    };

    const result = await sendApprovalReadyNotification(
      { kind: "social", contentId: "run-1" },
      prisma,
      sender,
    );

    expect(result.status).toBe("auto_publish_enabled");
    expect(sends).toBe(0);
  });

  test("sends a Google Business Profile approval email", async () => {
    useProductionDashboardEnvironment();
    const sent: any[] = [];
    const prisma = {
      gMBPostSuggestion: {
        findUnique: async () => gmbSuggestion(),
        updateMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const sender = {
      sendContentApprovalReadyEmail: async (input: any) => {
        sent.push(input);
        return { emailId: "email-2", success: true };
      },
    };

    const result = await sendApprovalReadyNotification(
      { kind: "gmb_post", contentId: "suggestion-1" },
      prisma,
      sender,
    );

    expect(result.status).toBe("sent");
    expect(sent[0]).toMatchObject({
      contentLabel: "Google Business Profile",
      reviewUrl: "https://dashboard.upliftai.co/dashboard/gmb-posts",
      idempotencyKey: "approval-ready-gmb-suggestion-1",
    });
  });

  test("releases the database claim when email delivery fails", async () => {
    const updates: any[] = [];
    const prisma = {
      socialCreativeRun: {
        findUnique: async () => socialRun(),
        updateMany: async (input: any) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const sender = {
      sendContentApprovalReadyEmail: async () => ({
        emailId: "",
        success: false,
        error: "Provider unavailable",
      }),
    };

    await expect(
      sendApprovalReadyNotification(
        { kind: "social", contentId: "run-1" },
        prisma,
        sender,
      ),
    ).rejects.toThrow("Provider unavailable");
    expect(updates).toHaveLength(2);
    expect(updates[1].data).toEqual({ approvalEmailClaimedAt: null });
  });

  test("uses plain transactional copy without promotional language", () => {
    const text = generateContentApprovalReadyEmailText({
      userName: "Alex",
      businessName: "Example Studio",
      contentLabel: "social media",
      reviewUrl: "https://dashboard.upliftai.co/dashboard/social/posts/run-1",
    });

    expect(text).toContain("ready to review");
    expect(text).toContain("Review and publish the post:");
    expect(text.toLowerCase()).not.toContain("upgrade");
    expect(text.toLowerCase()).not.toContain("promotion");
    expect(text.toLowerCase()).not.toContain("free trial");
  });

  test("rewrites a production marketing origin to the dashboard", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DASHBOARD_URL;
    process.env.FRONTEND_URL = "https://upliftai.co";

    expect(contentApprovalReviewUrl("/dashboard/social/posts/run-1")).toBe(
      "https://dashboard.upliftai.co/dashboard/social/posts/run-1",
    );
  });

  test("keeps the configured localhost dashboard during development", () => {
    process.env.NODE_ENV = "development";
    process.env.DASHBOARD_URL = "http://localhost:3001";

    expect(contentApprovalReviewUrl("/dashboard/social/posts/run-1")).toBe(
      "http://localhost:3001/dashboard/social/posts/run-1",
    );
  });
});

describe("content approval notification recovery", () => {
  test("redrives unnotified social and GMB approval content", async () => {
    const registered: Array<{
      config: any;
      handler: (context: any) => Promise<any>;
    }> = [];
    const inngest = {
      createFunction: (config: any, handler: (context: any) => Promise<any>) => {
        const fn = { config, handler };
        registered.push(fn);
        return fn;
      },
    } as any;
    const prisma = {
      socialCreativeRun: { findMany: async () => [{ id: "run-1" }] },
      gMBPostSuggestion: {
        findMany: async () => [{ id: "suggestion-1" }],
      },
    } as unknown as PrismaClient;
    createContentApprovalNotificationFunctions(inngest, { prisma });
    const recovery = registered.find(
      (candidate) =>
        candidate.config.id === "content-approval-ready-notification-recovery",
    )!;
    const sent: unknown[] = [];

    const result = await recovery.handler({
      step: {
        run: async (_id: string, fn: () => unknown) => fn(),
        sendEvent: async (_id: string, events: unknown) => sent.push(events),
      },
    });

    expect(result).toEqual({ social: 1, gmb: 1, dispatched: 2 });
    expect(sent).toEqual([
      [
        {
          id: "approval-ready-social:run-1",
          name: "content/approval-ready",
          data: { kind: "social", contentId: "run-1" },
        },
        {
          id: "approval-ready-gmb:suggestion-1",
          name: "content/approval-ready",
          data: { kind: "gmb_post", contentId: "suggestion-1" },
        },
      ],
    ]);
  });
});
