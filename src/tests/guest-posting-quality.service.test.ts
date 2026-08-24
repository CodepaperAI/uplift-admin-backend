import { describe, expect, it } from "bun:test";
import {
  evaluateGuestPostPublisher,
  getHighAuthorityCampaignDefaults,
  HIGH_AUTHORITY_MAX_SPAM_SCORE,
  HIGH_AUTHORITY_MIN_DA,
} from "../services/guest-posting-quality.service";
import { CREATE_CAMPAIGN } from "../validators/guest-posting.validation";

const highAuthorityCampaign = {
  ...getHighAuthorityCampaignDefaults(),
  targetNiche: "Dental Marketing",
  targetKeywords: ["best dentist seo"],
};

describe("guest posting quality gates", () => {
  it("qualifies verified high-authority editorial publishers", () => {
    const evaluation = evaluateGuestPostPublisher(
      {
        name: "Dental Growth Journal",
        domainAuthority: HIGH_AUTHORITY_MIN_DA + 12,
        monthlyTraffic: 75_000,
        spamScore: 4,
        niche: "Dental marketing and growth",
        contactEmail: "editor@example.com",
        submissionGuidelines: "Original editorial posts only.",
        acceptsLinks: true,
        linkTypesAllowed: ["dofollow", "nofollow"],
        isVerified: true,
      },
      highAuthorityCampaign,
    );

    expect(evaluation.status).toBe("QUALIFIED");
    expect(evaluation.complianceStatus).toBe("APPROVED");
    expect(evaluation.placementType).toBe("EDITORIAL");
    expect(evaluation.requiredLinkRel).toBe("none");
    expect(evaluation.canCreateSubmission).toBe(true);
    expect(evaluation.canGeneratePitch).toBe(true);
    expect(evaluation.canAutoSend).toBe(true);
  });

  it("blocks auto-send when publishers fail high-authority requirements", () => {
    const evaluation = evaluateGuestPostPublisher(
      {
        name: "Thin Directory Blog",
        domainAuthority: HIGH_AUTHORITY_MIN_DA - 1,
        spamScore: HIGH_AUTHORITY_MAX_SPAM_SCORE + 1,
        niche: "General coupons",
        acceptsLinks: true,
        isVerified: false,
      },
      highAuthorityCampaign,
    );

    expect(evaluation.status).toBe("BLOCKED");
    expect(evaluation.canCreateSubmission).toBe(false);
    expect(evaluation.canGeneratePitch).toBe(false);
    expect(evaluation.canAutoSend).toBe(false);
    expect(evaluation.reasons.join(" ")).toContain("below the required");
    expect(evaluation.reasons.join(" ")).toContain("above the maximum");
    expect(evaluation.reasons.join(" ")).toContain("does not match");
    expect(evaluation.reasons.join(" ")).toContain("Contact email");
    expect(evaluation.reasons.join(" ")).toContain("must be verified");
  });

  it("blocks paid dofollow placements from automation", () => {
    const evaluation = evaluateGuestPostPublisher(
      {
        name: "Paid Dental Publisher",
        domainAuthority: 72,
        spamScore: 3,
        niche: "Dental Marketing",
        contactEmail: "sponsored@example.com",
        submissionGuidelines: "Paid placements accepted.",
        requiresPayment: true,
        acceptsLinks: true,
        linkTypesAllowed: ["dofollow"],
        isVerified: true,
      },
      highAuthorityCampaign,
    );

    expect(evaluation.status).toBe("BLOCKED");
    expect(evaluation.complianceStatus).toBe("BLOCKED");
    expect(evaluation.placementType).toBe("PAID");
    expect(evaluation.requiredLinkRel).toBe("sponsored");
    expect(evaluation.reasons.join(" ")).toContain("Paid dofollow");
    expect(evaluation.canAutoSend).toBe(false);
  });

  it("allows paid placements only when link qualification is safe", () => {
    const evaluation = evaluateGuestPostPublisher(
      {
        name: "Sponsored Dental Publisher",
        domainAuthority: 68,
        spamScore: 2,
        niche: "Dental Marketing",
        contactEmail: "sponsored@example.com",
        submissionGuidelines: "Sponsored placements use qualified links.",
        requiresPayment: true,
        acceptsLinks: true,
        linkTypesAllowed: ["sponsored", "nofollow"],
        isVerified: true,
      },
      highAuthorityCampaign,
    );

    expect(evaluation.status).toBe("QUALIFIED");
    expect(evaluation.complianceStatus).toBe("APPROVED");
    expect(evaluation.placementType).toBe("PAID");
    expect(evaluation.requiredLinkRel).toBe("nofollow");
    expect(evaluation.canAutoSend).toBe(true);
  });

  it("accepts dashboard date-only campaign values", () => {
    const parsed = CREATE_CAMPAIGN.parse({
      userId: "user-1",
      businessId: "biz-1",
      name: "High DR test campaign",
      startDate: "2026-06-12",
      endDate: "2026-07-12",
    });

    expect(parsed.startDate).toBe("2026-06-12");
    expect(parsed.endDate).toBe("2026-07-12");
    expect(parsed.campaignTemplate).toBe("HIGH_DR_GUEST_POSTING");
    expect(parsed.minDomainAuthority).toBeUndefined();
    expect(parsed.autoGeneratePitch).toBe(true);
    expect(parsed.autoSendPitch).toBe(false);
    expect(parsed.maxSubmissionsPerDay).toBe(3);
  });
});
