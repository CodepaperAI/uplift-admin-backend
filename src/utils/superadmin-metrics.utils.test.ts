import { describe, expect, it } from "bun:test";
import { classifyUserSubscriptionStatus } from "./superadmin-metrics.utils";

describe("classifyUserSubscriptionStatus", () => {
  it("marks users with an active paid website subscription as paid", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "none",
          business: [
            {
              websiteStatus: "active",
              websiteSubscription: {
                status: "active",
                stripeSubscriptionId: "sub_123",
                trialStatus: "none",
                trialEndDate: null,
              },
            },
          ],
        },
        null,
      ),
    ).toBe("paid");
  });

  it("marks users with an active website subscription as paid even without a legacy account subscription row", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "converted",
          business: [
            {
              websiteStatus: "active",
              websiteSubscription: {
                status: "active",
                stripeSubscriptionId: null,
                trialStatus: "converted",
                trialEndDate: null,
              },
            },
          ],
        },
        null,
      ),
    ).toBe("paid");
  });

  it("marks users with an active website trial as trial", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "none",
          business: [
            {
              websiteStatus: "trial",
              websiteSubscription: {
                status: "trialing",
                stripeSubscriptionId: null,
                trialStatus: "trialing",
                trialEndDate: new Date(Date.now() + 86400000),
              },
            },
          ],
        },
        null,
      ),
    ).toBe("trial");
  });

  it("marks users with an expired website trial as expired", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "none",
          business: [
            {
              websiteStatus: "expired",
              websiteSubscription: {
                status: "trialing",
                stripeSubscriptionId: null,
                trialStatus: "trialing",
                trialEndDate: new Date(Date.now() - 86400000),
              },
            },
          ],
        },
        null,
      ),
    ).toBe("expired");
  });

  it("treats users without site-level paid or trial evidence as expired even if a legacy account subscription exists", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "active",
          trialEndDate: new Date(Date.now() + 86400000),
          business: [],
        },
        {
          status: "trialing",
          stripeSubscriptionId: "sub_legacy",
          currentPeriodEnd: new Date(Date.now() + 86400000),
        },
      ),
    ).toBe("expired");
  });

  it("does not treat business.websiteStatus as trial access when WebsiteSubscription is missing", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "none",
          business: [
            {
              websiteStatus: "trial",
              websiteSubscription: null,
            },
          ],
        },
        null,
      ),
    ).toBe("expired");
  });

  it("marks users without paid or trial evidence as expired", () => {
    expect(
      classifyUserSubscriptionStatus(
        {
          trialStatus: "none",
          business: [
            {
              websiteStatus: "inactive",
              websiteSubscription: {
                status: "canceled",
                stripeSubscriptionId: null,
                trialStatus: "none",
                trialEndDate: null,
              },
            },
          ],
        },
        null,
      ),
    ).toBe("expired");
  });
});
