import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const findManyMock = mock(async (_args: unknown): Promise<any[]> => []);
const findUniqueMock = mock(async (_args: unknown): Promise<any> => null);
const findFirstMock = mock(async (_args: unknown): Promise<any> => null);
const updateMock = mock(async (_args: unknown): Promise<any> => null);

mock.module("../config/db.config", () => ({
  prisma: {
    googleMyBusiness: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
      update: updateMock,
    },
    business: {
      findUnique: mock(async () => null),
      findFirst: mock(async () => null),
      findMany: mock(async () => []),
    },
  },
}));

let service: typeof import("../services/google-my-business.service");

beforeAll(async () => {
  service = await import("../services/google-my-business.service");
});

beforeEach(() => {
  findManyMock.mockReset();
  findUniqueMock.mockReset();
  findFirstMock.mockReset();
  updateMock.mockReset();
});

describe("Auto-publish gating: approval_required must not auto-fire", () => {
  it("isAutoReviewReplyEnabled returns false when reviewReplyMode is approval_required", async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      autoPostToGmbEnabled: true,
      autoReviewReplyEnabled: true,
      postAutomationMode: "approval_required",
      reviewReplyMode: "approval_required",
      profileEditMode: "approval_required",
      mediaPublishingMode: "approval_required",
      rankScanCadence: "weekly",
      notificationPreferences: null,
    }));

    const gmbService = new service.GoogleMyBusinessService();
    const enabled = await gmbService.isAutoReviewReplyEnabled("biz-1");
    expect(enabled).toBe(false);
  });

  it("isAutoReviewReplyEnabled returns true only when reviewReplyMode is auto_publish", async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      autoPostToGmbEnabled: true,
      autoReviewReplyEnabled: true,
      postAutomationMode: "auto_publish",
      reviewReplyMode: "auto_publish",
      profileEditMode: "approval_required",
      mediaPublishingMode: "approval_required",
      rankScanCadence: "weekly",
      notificationPreferences: null,
    }));

    const gmbService = new service.GoogleMyBusinessService();
    const enabled = await gmbService.isAutoReviewReplyEnabled("biz-1");
    expect(enabled).toBe(true);
  });

  it("isAutoPostToGmbEnabled returns false when postAutomationMode is approval_required", async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      autoPostToGmbEnabled: true,
      autoReviewReplyEnabled: true,
      postAutomationMode: "approval_required",
      reviewReplyMode: "approval_required",
      profileEditMode: "approval_required",
      mediaPublishingMode: "approval_required",
      rankScanCadence: "weekly",
      notificationPreferences: null,
    }));

    const gmbService = new service.GoogleMyBusinessService();
    const enabled = await gmbService.isAutoPostToGmbEnabled("biz-1");
    expect(enabled).toBe(false);
  });

  it("isAutoPostToGmbEnabled returns true only when postAutomationMode is auto_publish", async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      autoPostToGmbEnabled: true,
      autoReviewReplyEnabled: true,
      postAutomationMode: "auto_publish",
      reviewReplyMode: "auto_publish",
      profileEditMode: "approval_required",
      mediaPublishingMode: "approval_required",
      rankScanCadence: "weekly",
      notificationPreferences: null,
    }));

    const gmbService = new service.GoogleMyBusinessService();
    const enabled = await gmbService.isAutoPostToGmbEnabled("biz-1");
    expect(enabled).toBe(true);
  });

  it("isAutoReviewReplyEnabled returns false when mode is disabled even if legacy boolean is true", async () => {
    findUniqueMock.mockImplementationOnce(async () => ({
      autoPostToGmbEnabled: true,
      autoReviewReplyEnabled: true,
      postAutomationMode: "disabled",
      reviewReplyMode: "disabled",
      profileEditMode: "disabled",
      mediaPublishingMode: "disabled",
      rankScanCadence: "manual",
      notificationPreferences: null,
    }));

    const gmbService = new service.GoogleMyBusinessService();
    const enabled = await gmbService.isAutoReviewReplyEnabled("biz-1");
    expect(enabled).toBe(false);
  });
});
