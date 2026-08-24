import { describe, it, expect } from "bun:test";

type PerSiteSubscriptionStatus =
  | "subscribed"
  | "not_subscribed"
  | "trial"
  | "expired";

interface WebsiteSubscription {
  status: string;
  trialStatus?: string;
  trialEndDate?: Date | null;
}

function deriveSubscriptionStatus(
  ws: WebsiteSubscription | null,
  perSiteTrialsEnabled: boolean,
  isAccountActive: boolean,
  businessWebsiteStatus: string
): PerSiteSubscriptionStatus {
  if (perSiteTrialsEnabled) {
    if (!ws) {
      if (businessWebsiteStatus === "trial") {
        return "trial";
      }
      if (businessWebsiteStatus === "expired") {
        return "expired";
      }
      return "not_subscribed";
    }

    const trialDateExpired =
      ws.trialEndDate && new Date(ws.trialEndDate) <= new Date();

    if (
      ws.trialStatus === "expired" ||
      ws.status === "expired" ||
      ((ws.trialStatus === "trialing" || ws.status === "trialing") &&
        trialDateExpired)
    ) {
      return "expired";
    }
    if (
      ws.trialStatus === "trialing" &&
      ws.trialEndDate &&
      new Date(ws.trialEndDate) > new Date()
    ) {
      return "trial";
    }
    if (ws.status === "active" && ws.trialStatus !== "trialing") {
      return "subscribed";
    }
    return "not_subscribed";
  }

  const badStatuses = [
    "past_due",
    "unpaid",
    "incomplete",
    "suspended",
    "canceled",
    "expired",
  ];
  if (ws && badStatuses.includes(ws.status)) {
    return ws.status === "expired" ? "expired" : "not_subscribed";
  }
  if (ws && (ws.status === "active" || ws.status === "trialing")) {
    return "subscribed";
  }
  if (isAccountActive && businessWebsiteStatus === "active") {
    return "subscribed";
  }
  if (businessWebsiteStatus === "trial") {
    return "trial";
  }
  if (businessWebsiteStatus === "expired") {
    return "expired";
  }
  return "not_subscribed";
}

describe("Subscription status mapping (PER_SITE_TRIALS_ENABLED = true)", () => {
  const perSite = true;

  it("active ws + no trial → subscribed", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "active", trialStatus: undefined, trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("subscribed");
  });

  it("trialing + future trialEndDate → trial", () => {
    const future = new Date(Date.now() + 86400000);
    expect(
      deriveSubscriptionStatus(
        { status: "trialing", trialStatus: "trialing", trialEndDate: future },
        perSite,
        true,
        "trial"
      )
    ).toBe("trial");
  });

  it("trialing + expired trialEndDate → expired (NEVER subscribed)", () => {
    const past = new Date(Date.now() - 86400000);
    expect(
      deriveSubscriptionStatus(
        { status: "trialing", trialStatus: "trialing", trialEndDate: past },
        perSite,
        true,
        "active"
      )
    ).toBe("expired");
  });

  it("ws.status trialing + expired date (no trialStatus) → expired", () => {
    const past = new Date(Date.now() - 86400000);
    expect(
      deriveSubscriptionStatus(
        { status: "trialing", trialEndDate: past },
        perSite,
        true,
        "active"
      )
    ).toBe("expired");
  });

  it("trialStatus=expired → expired", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "active", trialStatus: "expired", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("expired");
  });

  it("ws.status=expired → expired", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "expired", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("expired");
  });

  it("past_due is NEVER subscribed (even if account active)", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "past_due", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("unpaid is NEVER subscribed (even if account active)", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "unpaid", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("incomplete is NEVER subscribed (even if account active)", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "incomplete", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("suspended is NEVER subscribed (even if account active)", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "suspended", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("canceled is NEVER subscribed (even if account active)", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "canceled", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("missing ws + active business is NEVER subscribed in per-site mode", () => {
    expect(deriveSubscriptionStatus(null, perSite, true, "active")).toBe(
      "not_subscribed"
    );
  });
});

describe("Subscription status mapping (PER_SITE_TRIALS_ENABLED = false)", () => {
  const perSite = false;

  it("ws.status=active → subscribed", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "active", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("subscribed");
  });

  it("ws.status=past_due + account active → not_subscribed (no fallback)", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "past_due", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("ws.status=unpaid + account active → not_subscribed", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "unpaid", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("ws.status=suspended + account active → not_subscribed", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "suspended", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("ws.status=canceled + account active → not_subscribed", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "canceled", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("not_subscribed");
  });

  it("ws.status=expired → expired", () => {
    expect(
      deriveSubscriptionStatus(
        { status: "expired", trialEndDate: null },
        perSite,
        true,
        "active"
      )
    ).toBe("expired");
  });

  it("no ws + account active + business active → subscribed (account fallback)", () => {
    expect(
      deriveSubscriptionStatus(null, perSite, true, "active")
    ).toBe("subscribed");
  });

  it("no ws + account inactive + business trial → trial", () => {
    expect(
      deriveSubscriptionStatus(null, perSite, false, "trial")
    ).toBe("trial");
  });

  it("no ws + account inactive + business expired → expired", () => {
    expect(
      deriveSubscriptionStatus(null, perSite, false, "expired")
    ).toBe("expired");
  });
});
