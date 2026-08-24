import { describe, expect, it } from "bun:test";
import {
  applyDismissalFeedback,
  isValidStatus,
  mergeStatuses,
  type PersistedStatus,
} from "../services/offpage/offpage-status.service";
import type { Opportunity, OpportunityStatus } from "../services/offpage/offpage-types";

function opp(key: string, status: OpportunityStatus = "todo"): Opportunity {
  return {
    leverKey: "directory",
    key,
    title: key,
    action: "",
    priority: 50,
    rationale: "",
    status,
    businessTypeFit: "",
  };
}

describe("isValidStatus", () => {
  it("accepts the four valid statuses, rejects others", () => {
    expect(isValidStatus("todo")).toBe(true);
    expect(isValidStatus("in_progress")).toBe(true);
    expect(isValidStatus("done")).toBe(true);
    expect(isValidStatus("dismissed")).toBe(true);
    expect(isValidStatus("nonsense")).toBe(false);
    expect(isValidStatus(5)).toBe(false);
    expect(isValidStatus(undefined)).toBe(false);
  });
});

describe("mergeStatuses", () => {
  it("overrides computed status with persisted status by key", () => {
    const opps = [opp("directory:yelp"), opp("directory:bing")];
    const persisted = new Map<string, PersistedStatus>([
      ["directory:yelp", { status: "done", verificationStatus: "verified" }],
    ]);
    const merged = mergeStatuses(opps, persisted);
    const yelp = merged.find((o) => o.key === "directory:yelp");
    expect(yelp?.status).toBe("done");
    expect(yelp?.verificationStatus).toBe("verified");
    expect(merged.find((o) => o.key === "directory:bing")?.status).toBe("todo");
  });

  it("leaves opportunities untouched when there's no persisted status", () => {
    const opps = [opp("directory:yelp")];
    expect(mergeStatuses(opps, new Map())).toEqual(opps);
  });

  it("preserves dismissed feedback reasons on merged opportunities", () => {
    const opps = [opp("reddit:toronto")];
    const persisted = new Map<string, PersistedStatus>([
      [
        "reddit:toronto",
        {
          status: "dismissed",
          verificationStatus: null,
          dismissReason: "wrong location",
        },
      ],
    ]);

    const merged = mergeStatuses(opps, persisted);
    expect(merged[0]?.status).toBe("dismissed");
    expect(merged[0]?.dismissReason).toBe("wrong location");
  });

  it("clears stale dismiss reasons when an opportunity is no longer dismissed", () => {
    const opps = [{ ...opp("reddit:toronto"), dismissReason: "wrong location" }];
    const persisted = new Map<string, PersistedStatus>([
      [
        "reddit:toronto",
        {
          status: "todo",
          verificationStatus: null,
          dismissReason: "wrong location",
        },
      ],
    ]);

    const merged = mergeStatuses(opps, persisted);
    expect(merged[0]?.status).toBe("todo");
    expect(merged[0]?.dismissReason).toBeNull();
  });
});

describe("applyDismissalFeedback", () => {
  it("removes exact previously dismissed opportunities and records the reason", () => {
    const result = applyDismissalFeedback(
      [
        { ...opp("reddit:toronto"), leverKey: "reddit" },
        opp("directory:yelp"),
      ],
      [
        {
          opportunityKey: "reddit:toronto",
          leverKey: "reddit",
          reason: "wrong location",
        },
      ],
    );

    expect(result.opportunities.map((o) => o.key)).toEqual(["directory:yelp"]);
    expect(result.rejectedOpportunities).toEqual([
      {
        key: "reddit:toronto",
        leverKey: "reddit",
        title: "reddit:toronto",
        reason: "User feedback: wrong location",
        score: 0,
      },
    ]);
  });
});
