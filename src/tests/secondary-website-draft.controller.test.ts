import { afterEach, describe, expect, it } from "bun:test";
import type { Response } from "express";

import { prisma } from "../config/db.config";
import { getSecondaryWebsiteDraft } from "../controllers/website.controller";

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

  return { res, status: () => statusCode, body: () => body };
}

const businessDelegate = prisma.business as unknown as {
  findFirst: typeof prisma.business.findFirst;
};
const originalFindFirst = businessDelegate.findFirst;

afterEach(() => {
  businessDelegate.findFirst = originalFindFirst;
});

describe("secondary website draft controller", () => {
  it("returns an owned pending inactive website so completion polling remains readable", async () => {
    let where: Record<string, unknown> | undefined;
    businessDelegate.findFirst = ((async (args: unknown) => {
      where = (args as { where?: Record<string, unknown> }).where;
      return {
        id: "secondary-business",
        userId: "authenticated-user",
        businessName: "Pending website",
        businessWebsiteUrl: "https://pending.example.com/",
        businessPhone: null,
        businessAddress: null,
        businessCity: null,
        businessState: null,
        businessCountry: null,
        websiteStatus: "pending",
        isActive: false,
        onboardingFlow: "website_secondary",
        onboardingStatus: "running",
        onboardingLastError: null,
        secondaryDetailsConfirmed: true,
        websiteAnalysis: { id: "analysis-id" },
        websiteSubscription: { status: "active" },
      };
    }) as unknown) as typeof businessDelegate.findFirst;

    const response = mockResponse();
    await getSecondaryWebsiteDraft(
      {
        authUserId: "authenticated-user",
        body: { businessId: "secondary-business" },
      } as never,
      response.res,
    );

    expect(where).toEqual({
      id: "secondary-business",
      userId: "authenticated-user",
      removalStatus: "active",
    });
    expect(response.status()).toBe(200);
    expect(response.body()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          businessId: "secondary-business",
          onboardingStatus: "running",
        }),
      }),
    );
  });
});
