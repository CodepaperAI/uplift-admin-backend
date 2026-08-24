import { afterEach, describe, expect, it } from "bun:test";
import type { Response } from "express";

import { prisma } from "../config/db.config";
import { getOnboardingV2State } from "../controllers/quick-scrape.controller";

function mockResponse() {
  let statusCode = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    status: () => statusCode,
    body: () => body,
  };
}

const quickDelegate = prisma.quickScrapeBusiness as unknown as {
  findFirst: typeof prisma.quickScrapeBusiness.findFirst;
  update: typeof prisma.quickScrapeBusiness.update;
};
const userDelegate = prisma.user as unknown as {
  findUnique: typeof prisma.user.findUnique;
};
const businessDelegate = prisma.business as unknown as {
  findFirst: typeof prisma.business.findFirst;
};
const websiteSubscriptionDelegate = prisma.websiteSubscription as unknown as {
  findUnique: typeof prisma.websiteSubscription.findUnique;
};
const originalFindFirst = quickDelegate.findFirst;
const originalQuickUpdate = quickDelegate.update;
const originalUserFindUnique = userDelegate.findUnique;
const originalBusinessFindFirst = businessDelegate.findFirst;
const originalWebsiteSubscriptionFindUnique =
  websiteSubscriptionDelegate.findUnique;

afterEach(() => {
  quickDelegate.findFirst = originalFindFirst;
  quickDelegate.update = originalQuickUpdate;
  userDelegate.findUnique = originalUserFindUnique;
  businessDelegate.findFirst = originalBusinessFindFirst;
  websiteSubscriptionDelegate.findUnique =
    originalWebsiteSubscriptionFindUnique;
});

describe("onboarding-v2 state controller authorization", () => {
  it("rejects a spoofed userId when no authenticated user is present", async () => {
    let queried = false;
    quickDelegate.findFirst = (async () => {
      queried = true;
      return null;
    }) as typeof quickDelegate.findFirst;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        query: { userId: "spoofed-user" },
      } as never,
      response.res,
    );

    expect(queried).toBe(false);
    expect(response.status()).toBe(401);
    expect(response.body()).toEqual(
      expect.objectContaining({ success: false, message: "Unauthorized" }),
    );
  });

  it("scopes an explicit state lookup to the authenticated owner", async () => {
    let where: unknown;
    quickDelegate.findFirst = (async (args: unknown) => {
      where = (args as { where?: unknown }).where;
      return null;
    }) as typeof quickDelegate.findFirst;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        authUserId: "authenticated-user",
        query: { businessId: "3059d111-4383-49ed-a33d-098fafad98c4" },
      } as never,
      response.res,
    );

    expect(where).toEqual({
      id: "3059d111-4383-49ed-a33d-098fafad98c4",
      userId: "authenticated-user",
    });
    expect(response.status()).toBe(404);
  });

  it("does not implicitly resume untouched legacy quick-scrape rows", async () => {
    let where: unknown;
    quickDelegate.findFirst = (async (args: unknown) => {
      where = (args as { where?: unknown }).where;
      return null;
    }) as typeof quickDelegate.findFirst;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        authUserId: "authenticated-user",
        query: {},
      } as never,
      response.res,
    );

    expect(where).toEqual({
      userId: "authenticated-user",
      onboardingV2Flow: "trial_primary",
      onboardingV2Status: { not: "completed" },
      onboardingV2LastSeenAt: { not: null },
    });
    expect(response.status()).toBe(200);
    expect(response.body()).toEqual(
      expect.objectContaining({
        success: true,
        data: { state: null },
      }),
    );
  });

  it("uses the authenticated signup phone instead of a scraped business phone", async () => {
    let userQueried = false;
    let quickUpdated = false;
    quickDelegate.findFirst = (async () => ({
      id: "3059d111-4383-49ed-a33d-098fafad98c4",
      userId: "authenticated-user",
      businessPhone: "+14165550123",
    })) as typeof quickDelegate.findFirst;
    quickDelegate.update = (async () => {
      quickUpdated = true;
      throw new Error("GET must not persist onboarding state");
    }) as typeof quickDelegate.update;
    userDelegate.findUnique = ((async () => {
      userQueried = true;
      return { phone: "+16475550987" };
    }) as unknown) as typeof userDelegate.findUnique;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        authUserId: "authenticated-user",
        query: { businessId: "3059d111-4383-49ed-a33d-098fafad98c4" },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(200);
    expect((response.body() as any).data.state.businessDetails.businessPhone).toBe(
      "+16475550987",
    );
    expect(userQueried).toBe(true);
    expect(quickUpdated).toBe(false);
  });

  it("prefills an empty business phone from only the authenticated user's E.164 phone", async () => {
    let userWhere: unknown;
    let userSelect: unknown;
    let quickUpdated = false;
    quickDelegate.findFirst = (async () => ({
      id: "3059d111-4383-49ed-a33d-098fafad98c4",
      userId: "authenticated-user",
      businessPhone: null,
    })) as typeof quickDelegate.findFirst;
    quickDelegate.update = (async () => {
      quickUpdated = true;
      throw new Error("GET must not persist onboarding state");
    }) as typeof quickDelegate.update;
    userDelegate.findUnique = ((async (args: unknown) => {
      const query = args as { where?: unknown; select?: unknown };
      userWhere = query.where;
      userSelect = query.select;
      return { phone: "+16475550987" };
    }) as unknown) as typeof userDelegate.findUnique;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        authUserId: "authenticated-user",
        query: { businessId: "3059d111-4383-49ed-a33d-098fafad98c4" },
      } as never,
      response.res,
    );

    expect(userWhere).toEqual({ id: "authenticated-user" });
    expect(userSelect).toEqual({ phone: true });
    expect((response.body() as any).data.state.businessDetails.businessPhone).toBe(
      "+16475550987",
    );
    expect(quickUpdated).toBe(false);
  });

  it("does not expose a non-E.164 signup phone as onboarding contact data", async () => {
    quickDelegate.findFirst = (async () => ({
      id: "3059d111-4383-49ed-a33d-098fafad98c4",
      userId: "authenticated-user",
      businessPhone: "",
    })) as typeof quickDelegate.findFirst;
    userDelegate.findUnique = ((async () => ({
      phone: "(647) 555-0987",
    })) as unknown) as typeof userDelegate.findUnique;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        authUserId: "authenticated-user",
        query: { businessId: "3059d111-4383-49ed-a33d-098fafad98c4" },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(200);
    expect((response.body() as any).data.state.businessDetails.businessPhone).toBe(
      "",
    );
  });

  it("restores an owned completed secondary state after that website becomes primary", async () => {
    let linkedBusinessWhere: Record<string, unknown> | undefined;
    quickDelegate.findFirst = ((async () => ({
      id: "3059d111-4383-49ed-a33d-098fafad98c4",
      userId: "authenticated-user",
      onboardingV2Flow: "website_secondary",
      onboardingV2BusinessId: "secondary-business",
      onboardingV2Status: "completed",
      onboardingV2Step: "complete",
      detectedServices: [],
      selectedServices: [],
    })) as unknown) as typeof quickDelegate.findFirst;
    businessDelegate.findFirst = ((async (args: unknown) => {
      linkedBusinessWhere = (args as { where?: Record<string, unknown> }).where;
      return { id: "secondary-business" };
    }) as unknown) as typeof businessDelegate.findFirst;
    websiteSubscriptionDelegate.findUnique = ((async () => ({
      status: "active",
    })) as unknown) as typeof websiteSubscriptionDelegate.findUnique;
    userDelegate.findUnique = ((async () => ({
      phone: null,
    })) as unknown) as typeof userDelegate.findUnique;

    const response = mockResponse();
    await getOnboardingV2State(
      {
        authUserId: "authenticated-user",
        query: { businessId: "3059d111-4383-49ed-a33d-098fafad98c4" },
      } as never,
      response.res,
    );

    expect(linkedBusinessWhere).toEqual({
      id: "secondary-business",
      userId: "authenticated-user",
      onboardingFlow: "website_secondary",
      removalStatus: "active",
    });
    expect(response.status()).toBe(200);
    expect((response.body() as any).data.state.status).toBe("completed");
  });
});
