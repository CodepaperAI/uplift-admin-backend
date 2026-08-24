import { afterEach, describe, expect, it } from "bun:test";
import type { Response } from "express";
import { prisma } from "../config/db.config";
import {
  connectGMB,
  createGMBPost,
  disconnectGMB,
  getGMBConnectionStatus,
  getGMBSettings,
  updateBusinessInfo,
  updateGMBSettings,
} from "../controllers/google-my-business.controller";
import { gmbLocalVisibilityService } from "../services/gmb-local-visibility.service";
import { GoogleMyBusinessService } from "../services/google-my-business.service";

function createMockResponse() {
  let statusCode = 200;
  let jsonBody: unknown;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getJson: () => jsonBody,
  };
}

const originalGetConnectionStatus =
  GoogleMyBusinessService.prototype.getConnectionStatus;
const originalDisconnect = GoogleMyBusinessService.prototype.disconnect;
const originalCreatePost = GoogleMyBusinessService.prototype.createPost;
const originalGetAutomationSettings =
  GoogleMyBusinessService.prototype.getAutomationSettings;
const originalUpdateAutomationSettings =
  GoogleMyBusinessService.prototype.updateAutomationSettings;
const originalCompleteOAuthConnection =
  GoogleMyBusinessService.prototype.completeOAuthConnection;
const originalQueueProfileEditAction =
  gmbLocalVisibilityService.queueProfileEditAction;
const businessDelegate = prisma.business as unknown as {
  findFirst: typeof prisma.business.findFirst;
};
const originalBusinessFindFirst = businessDelegate.findFirst;
const originalFetch = globalThis.fetch;

afterEach(() => {
  GoogleMyBusinessService.prototype.getConnectionStatus =
    originalGetConnectionStatus;
  GoogleMyBusinessService.prototype.disconnect = originalDisconnect;
  GoogleMyBusinessService.prototype.createPost = originalCreatePost;
  GoogleMyBusinessService.prototype.getAutomationSettings =
    originalGetAutomationSettings;
  GoogleMyBusinessService.prototype.updateAutomationSettings =
    originalUpdateAutomationSettings;
  GoogleMyBusinessService.prototype.completeOAuthConnection =
    originalCompleteOAuthConnection;
  gmbLocalVisibilityService.queueProfileEditAction =
    originalQueueProfileEditAction;
  businessDelegate.findFirst = originalBusinessFindFirst;
  globalThis.fetch = originalFetch;
});

describe("Google My Business controllers use authenticated user for business ownership", () => {
  it("status ignores spoofed body userId and resolves the business through auth user ownership", async () => {
    let capturedBusinessId = "";
    let capturedBusinessLookup: Record<string, unknown> | undefined;

    businessDelegate.findFirst = (async (...args: any[]) => {
      capturedBusinessLookup = (args[0]?.where ?? {}) as Record<string, unknown>;
      return { id: "business-1" };
    }) as any;

    GoogleMyBusinessService.prototype.getConnectionStatus = async function (
      businessId: string
    ) {
      capturedBusinessId = businessId;
      return { state: "disconnected" };
    };

    const response = createMockResponse();
    await getGMBConnectionStatus(
      {
        authUserId: "auth-user-id",
        body: {
          userId: "spoofed-user-id",
          businessId: "business-1",
        },
      } as never,
      response.res
    );

    expect(capturedBusinessLookup).toEqual({
      id: "business-1",
      userId: "auth-user-id",
      isActive: true,
    });
    expect(capturedBusinessId).toBe("business-1");
    expect(response.getStatus()).toBe(200);
  });

  it("disconnect ignores spoofed body userId and resolves the business through auth user ownership", async () => {
    let capturedBusinessId = "";
    let capturedBusinessLookup: Record<string, unknown> | undefined;

    businessDelegate.findFirst = (async (...args: any[]) => {
      capturedBusinessLookup = (args[0]?.where ?? {}) as Record<string, unknown>;
      return { id: "business-2" };
    }) as any;

    GoogleMyBusinessService.prototype.disconnect = async function (
      businessId: string
    ) {
      capturedBusinessId = businessId;
      return {
        success: true,
        message: "ok",
      };
    };

    const response = createMockResponse();
    await disconnectGMB(
      {
        authUserId: "auth-user-id",
        body: {
          userId: "spoofed-user-id",
          businessId: "business-2",
        },
      } as never,
      response.res
    );

    expect(capturedBusinessLookup).toEqual({
      id: "business-2",
      userId: "auth-user-id",
      isActive: true,
    });
    expect(capturedBusinessId).toBe("business-2");
    expect(response.getStatus()).toBe(200);
  });

  it("returns 401 when auth user is missing", async () => {
    let wasBusinessLookupCalled = false;
    let wasServiceCalled = false;

    businessDelegate.findFirst = (async () => {
      wasBusinessLookupCalled = true;
      return { id: "business-1" };
    }) as any;

    GoogleMyBusinessService.prototype.getConnectionStatus = async function () {
      wasServiceCalled = true;
      return { state: "disconnected" };
    };

    const response = createMockResponse();
    await getGMBConnectionStatus(
      {
        body: { userId: "spoofed-user-id", businessId: "business-1" },
      } as never,
      response.res
    );

    expect(wasBusinessLookupCalled).toBe(false);
    expect(wasServiceCalled).toBe(false);
    expect(response.getStatus()).toBe(401);
    expect(response.getJson()).toEqual(
      expect.objectContaining({
        success: false,
        message: "Unauthorized",
      })
    );
  });

  it("create post resolves the business through auth ownership and does not trust client location selection", async () => {
    let capturedBusinessId = "";
    let capturedPostData: Record<string, unknown> | undefined;

    businessDelegate.findFirst = (async () => {
      return { id: "business-3" };
    }) as any;

    GoogleMyBusinessService.prototype.createPost = async function (
      businessId: string,
      postData
    ) {
      capturedBusinessId = businessId;
      capturedPostData = postData as unknown as Record<string, unknown>;

      return {
        id: "post-1",
        postId: null,
        postType: "UPDATE",
        title: "Promo",
        summary: "Created from controller test",
        callToAction: null,
        mediaUrls: [],
        status: "PUBLISHED",
        publishedAt: new Date().toISOString(),
      };
    };

    const response = createMockResponse();
    await createGMBPost(
      {
        authUserId: "auth-user-id",
        body: {
          userId: "spoofed-user-id",
          businessId: "business-3",
          locationId: "spoofed-location-id",
          postType: "UPDATE",
          title: "Promo",
          summary: "Created from controller test",
          mediaUrls: ["https://cdn.example.com/post.jpg"],
        },
      } as never,
      response.res
    );

    expect(capturedBusinessId).toBe("business-3");
    expect(capturedPostData).toEqual({
      postType: "UPDATE",
      title: "Promo",
      summary: "Created from controller test",
      callToAction: undefined,
      mediaUrls: ["https://cdn.example.com/post.jpg"],
    });
    expect(response.getStatus()).toBe(200);
  });

  it("settings resolves the business through auth ownership", async () => {
    let capturedBusinessId = "";
    let capturedBusinessLookup: Record<string, unknown> | undefined;

    businessDelegate.findFirst = (async (...args: any[]) => {
      capturedBusinessLookup = (args[0]?.where ?? {}) as Record<string, unknown>;
      return { id: "business-settings" };
    }) as any;

    GoogleMyBusinessService.prototype.getAutomationSettings = async function (
      businessId: string
    ) {
      capturedBusinessId = businessId;
      return {
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: false,
        postAutomationMode: "approval_required",
        reviewReplyMode: "approval_required",
        profileEditMode: "approval_required",
        mediaPublishingMode: "approval_required",
        rankScanCadence: "weekly",
        notificationPreferences: null,
      };
    };

    const response = createMockResponse();
    await getGMBSettings(
      {
        authUserId: "auth-user-id",
        body: {
          userId: "spoofed-user-id",
          businessId: "business-settings",
        },
      } as never,
      response.res
    );

    expect(capturedBusinessLookup).toEqual({
      id: "business-settings",
      userId: "auth-user-id",
      isActive: true,
    });
    expect(capturedBusinessId).toBe("business-settings");
    expect(response.getStatus()).toBe(200);
    expect(response.getJson()).toEqual(
      expect.objectContaining({
        success: true,
        data: {
          autoPostToGmbEnabled: true,
          autoReviewReplyEnabled: false,
          postAutomationMode: "approval_required",
          reviewReplyMode: "approval_required",
          profileEditMode: "approval_required",
          mediaPublishingMode: "approval_required",
          rankScanCadence: "weekly",
          notificationPreferences: null,
        },
      })
    );
  });

  it("settings update allowlists only automation booleans", async () => {
    let capturedSettings: Record<string, unknown> | undefined;

    businessDelegate.findFirst = (async () => {
      return { id: "business-settings" };
    }) as any;

    GoogleMyBusinessService.prototype.updateAutomationSettings = async function (
      _businessId: string,
      settings
    ) {
      capturedSettings = settings as Record<string, unknown>;
      return {
        autoPostToGmbEnabled: false,
        autoReviewReplyEnabled: true,
        postAutomationMode: "approval_required",
        reviewReplyMode: "approval_required",
        profileEditMode: "approval_required",
        mediaPublishingMode: "approval_required",
        rankScanCadence: "weekly",
        notificationPreferences: null,
      };
    };

    const response = createMockResponse();
    await updateGMBSettings(
      {
        authUserId: "auth-user-id",
        body: {
          userId: "spoofed-user-id",
          businessId: "business-settings",
          autoPostToGmbEnabled: false,
          autoReviewReplyEnabled: true,
          isActive: false,
        },
      } as never,
      response.res
    );

    expect(capturedSettings).toEqual({
      autoPostToGmbEnabled: false,
      autoReviewReplyEnabled: true,
    });
    expect(response.getStatus()).toBe(200);
  });

  it("business update queues profile edits for approval instead of patching Google directly", async () => {
    let capturedBusinessId = "";
    let capturedBusinessData: Record<string, unknown> | undefined;

    businessDelegate.findFirst = (async () => {
      return { id: "business-settings" };
    }) as any;

    GoogleMyBusinessService.prototype.getAutomationSettings = async function () {
      return {
        autoPostToGmbEnabled: true,
        autoReviewReplyEnabled: true,
        postAutomationMode: "approval_required",
        reviewReplyMode: "approval_required",
        profileEditMode: "approval_required",
        mediaPublishingMode: "approval_required",
        rankScanCadence: "weekly",
        notificationPreferences: null,
      };
    };

    gmbLocalVisibilityService.queueProfileEditAction = async function (
      businessId,
      businessData
    ) {
      capturedBusinessId = businessId;
      capturedBusinessData = businessData;
      return {
        queued: true,
        action: {
          id: "action-1",
        },
      } as never;
    };

    const response = createMockResponse();
    await updateBusinessInfo(
      {
        authUserId: "auth-user-id",
        body: {
          userId: "spoofed-user-id",
          businessId: "business-settings",
          businessData: {
            description: "Updated profile description",
          },
        },
      } as never,
      response.res
    );

    expect(capturedBusinessId).toBe("business-settings");
    expect(capturedBusinessData).toEqual({
      description: "Updated profile description",
    });
    expect(response.getStatus()).toBe(200);
    expect(response.getJson()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ queued: true }),
      })
    );
  });

  it("connect uses the exact callback URL that initiated Google OAuth", async () => {
    let tokenRequestBody = "";
    const originalClientId = process.env.GOOGLE_CLIENT_ID;
    const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;

    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

    businessDelegate.findFirst = (async () => {
      return { id: "business-4" };
    }) as any;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokenRequestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof globalThis.fetch;

    GoogleMyBusinessService.prototype.completeOAuthConnection = async function () {
      return { state: "disconnected" };
    };

    try {
      const response = createMockResponse();
      await connectGMB(
        {
          authUserId: "auth-user-id",
          body: {
            businessId: "business-4",
            code: "google-auth-code",
            redirectUri:
              "https://dashboard.upliftai.co/api/auth/google-my-business/callback",
          },
        } as never,
        response.res
      );

      expect(tokenRequestBody).toContain(
        encodeURIComponent(
          "https://dashboard.upliftai.co/api/auth/google-my-business/callback"
        )
      );
      expect(response.getStatus()).toBe(200);
    } finally {
      process.env.GOOGLE_CLIENT_ID = originalClientId;
      process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
    }
  });
});
