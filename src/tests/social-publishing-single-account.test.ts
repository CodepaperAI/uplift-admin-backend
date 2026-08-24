import { describe, expect, it } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  assertSocialPlatformConnectionAvailable,
  selectSingleRemoteAccountPerPlatform,
  syncZernioAccounts,
} from "../services/zernio/social-publishing.service";
import type { ZernioClient } from "../services/zernio/zernio.client";

const account = (id: string, platform: string, isActive = true) => ({
  account: { _id: id, platform, isActive },
  platform: platform === "twitter" ? ("x" as const) : platform as "instagram" | "facebook" | "linkedin",
});

describe("social publishing single-account policy", () => {
  it("selects at most one active account for each platform", () => {
    const selected = selectSingleRemoteAccountPerPlatform([
      account("ig-1", "instagram"),
      account("ig-2", "instagram"),
      account("fb-1", "facebook"),
      account("li-1", "linkedin"),
      account("x-1", "twitter"),
    ]);

    expect(selected).toEqual({
      instagram: "ig-1",
      facebook: "fb-1",
      linkedin: "li-1",
      x: "x-1",
    });
  });

  it("prefers the callback account, then the previous account", () => {
    const remote = [
      account("ig-1", "instagram"),
      account("ig-2", "instagram"),
    ];

    expect(
      selectSingleRemoteAccountPerPlatform(remote, {
        preferredExternalAccountId: "ig-2",
        previousDefaults: { instagram: "ig-1" },
      }).instagram,
    ).toBe("ig-2");
    expect(
      selectSingleRemoteAccountPerPlatform(remote, {
        previousDefaults: { instagram: "ig-2" },
      }).instagram,
    ).toBe("ig-2");
  });

  it("ignores provider-disabled accounts", () => {
    expect(
      selectSingleRemoteAccountPerPlatform([
        account("fb-disabled", "facebook", false),
      ]),
    ).toEqual({});
  });

  it("keeps a locally blocked account inactive until its exact OAuth callback", () => {
    const remote = [account("x-expired", "twitter")];

    expect(
      selectSingleRemoteAccountPerPlatform(remote, {
        previousDefaults: { x: "x-expired" },
        blockedExternalAccountIds: new Set(["x-expired"]),
      }),
    ).toEqual({});
    expect(
      selectSingleRemoteAccountPerPlatform(remote, {
        preferredExternalAccountId: "x-expired",
        blockedExternalAccountIds: new Set(),
      }),
    ).toEqual({ x: "x-expired" });
  });

  it("does not reactivate an auth-expired account during a plain provider sync", async () => {
    const accountUpserts: any[] = [];
    const profile = {
      id: "profile-local",
      externalProfileId: "profile-zernio",
      accounts: [
        {
          externalAccountId: "x-expired",
          platform: "x",
          isActive: false,
          isDefault: false,
          publishAttempts: [{ id: "attempt-auth-expired" }],
        },
      ],
    };
    const tx = {
      socialPublisherAccount: {
        updateMany: async () => ({ count: 1 }),
        upsert: async (input: any) => {
          accountUpserts.push(input);
          return input.update;
        },
      },
      socialPublisherProfile: {
        update: async () => profile,
      },
    };
    const prisma = {
      socialPublisherProfile: { findUnique: async () => profile },
      socialPublisherAccount: {
        findFirst: async () => null,
        findMany: async () => [],
      },
      $transaction: async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
    } as unknown as PrismaClient;
    const client = {
      listAccounts: async () => [
        {
          _id: "x-expired",
          platform: "twitter",
          username: "ramsdr21",
          displayName: "Ramsudeer",
          isActive: true,
        },
      ],
    } as unknown as ZernioClient;

    await syncZernioAccounts({ businessId: "business-1" }, prisma, client);
    expect(accountUpserts[0]?.update).toMatchObject({
      isActive: false,
      isDefault: false,
    });

    accountUpserts.length = 0;
    await syncZernioAccounts(
      {
        businessId: "business-1",
        preferredExternalAccountId: "x-expired",
      },
      prisma,
      client,
    );
    expect(accountUpserts[0]?.update).toMatchObject({
      isActive: true,
      isDefault: true,
      disconnectedAt: null,
    });
  });

  it("blocks a second connection for the same business and platform", () => {
    let caught: unknown;
    try {
      assertSocialPlatformConnectionAvailable("instagram", true);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "SOCIAL_PLATFORM_ACCOUNT_ALREADY_CONNECTED",
      status: 409,
    });
  });
});
