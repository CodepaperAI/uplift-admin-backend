import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  reconcileActiveSocialPublishAttempts,
  zernioPostFailureDetails,
} from "../services/zernio/social-publishing.service";

describe("Zernio active publishing reconciliation", () => {
  test("does not require provider configuration when there are no active attempts", async () => {
    let queries = 0;
    const prisma = {
      socialPublishAttempt: {
        findMany: async () => {
          queries += 1;
          return [];
        },
      },
    } as unknown as PrismaClient;

    await expect(
      reconcileActiveSocialPublishAttempts(
        { userId: "user-1", runId: "run-1" },
        prisma,
      ),
    ).resolves.toBeUndefined();
    expect(queries).toBe(1);
  });

  test("advances a stale submitting attempt to the provider's published state", async () => {
    const updates: unknown[] = [];
    const prisma = {
      socialPublishAttempt: {
        findMany: async () => [
          {
            id: "attempt-1",
            externalPostId: "post-1",
            mode: "NOW",
            publisherAccountId: "account-1",
          },
        ],
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    await reconcileActiveSocialPublishAttempts(
      { userId: "user-1", runId: "run-1" },
      prisma,
      {
        getPost: async () => ({
          _id: "post-1",
          status: "published",
          platforms: [
            {
              platform: "instagram",
              status: "published",
              platformPostUrl: "https://www.instagram.com/p/post-1/",
            },
          ],
        }),
      },
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      where: { id: "attempt-1", status: "SUBMITTING" },
      data: {
        status: "PUBLISHED",
        externalStatus: "published",
        externalPostUrl: "https://www.instagram.com/p/post-1/",
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  });

  test("recognizes Zernio's Twitter refresh-token failure as reconnect-required", () => {
    expect(
      zernioPostFailureDetails({
        status: "failed",
        platforms: [
          {
            platform: "twitter",
            status: "failed",
            errorCategory: "auth_expired",
            errorMessage:
              'Token refresh failed: Bad Request - {"error":"invalid_request","error_description":"Value passed for the token was invalid."}',
          },
        ],
      }),
    ).toEqual({
      category: "auth_expired",
      code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED",
      message:
        "The social account authorization has expired. Reconnect the account before retrying this post.",
      reconnectRequired: true,
    });
  });

  test("fails the attempt and disables an account whose provider authorization expired", async () => {
    const attemptUpdates: unknown[] = [];
    const accountUpdates: unknown[] = [];
    const prisma = {
      socialPublishAttempt: {
        findMany: async () => [
          {
            id: "attempt-auth-expired",
            externalPostId: "post-auth-expired",
            mode: "SCHEDULE",
            publisherAccountId: "account-twitter",
          },
        ],
        updateMany: async (input: unknown) => {
          attemptUpdates.push(input);
          return { count: 1 };
        },
      },
      socialPublisherAccount: {
        updateMany: async (input: unknown) => {
          accountUpdates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    await reconcileActiveSocialPublishAttempts(
      { userId: "user-1", runId: "run-1" },
      prisma,
      {
        getPost: async () => ({
          _id: "post-auth-expired",
          status: "failed",
          platforms: [
            {
              platform: "twitter",
              status: "failed",
              errorCategory: "auth_expired",
              errorMessage: "Token refresh failed: invalid_grant",
            },
          ],
        }),
      },
    );

    expect(attemptUpdates).toHaveLength(1);
    expect(attemptUpdates[0]).toMatchObject({
      where: { id: "attempt-auth-expired", status: "SUBMITTING" },
      data: {
        status: "FAILED",
        lastErrorCode: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED",
        lastErrorMessage:
          "The social account authorization has expired. Reconnect the account before retrying this post.",
      },
    });
    expect(accountUpdates).toHaveLength(1);
    expect(accountUpdates[0]).toMatchObject({
      where: { id: "account-twitter" },
      data: {
        isActive: false,
        isDefault: false,
      },
    });
  });
});
