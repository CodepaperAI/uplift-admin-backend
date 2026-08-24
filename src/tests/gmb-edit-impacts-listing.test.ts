// Phase 2b: listEditImpactsForBusiness pairs baseline snapshots with their
// post snapshots and surfaces the deltaSummary to the UI.

import { beforeEach, describe, expect, it, mock } from "bun:test";

const baselineRows: Array<{
  id: string;
  businessId: string;
  gmbId: string;
  actionId: string;
  actionType: string;
  phase: "baseline";
  capturedAt: Date;
  action: { title: string | null; appliedAt: Date | null };
}> = [];

const postRows: Array<{
  actionId: string;
  capturedAt: Date;
  evaluatedAt: Date | null;
  deltaSummary: unknown;
}> = [];

const findManyMock = mock(async (args: { where: { phase: string; actionId?: { in: string[] } } }) => {
  if (args.where.phase === "baseline") {
    return baselineRows;
  }
  if (args.where.phase === "post") {
    const wanted = new Set(args.where.actionId?.in ?? []);
    return postRows.filter((p) => wanted.has(p.actionId));
  }
  return [];
});

mock.module("../config/db.config", () => ({
  prisma: {
    gMBEditImpactSnapshot: { findMany: findManyMock },
  },
}));

let listEditImpactsForBusiness: typeof import("../services/gmb-edit-impact.service").listEditImpactsForBusiness;

beforeEach(async () => {
  baselineRows.length = 0;
  postRows.length = 0;
  findManyMock.mockClear();
  ({ listEditImpactsForBusiness } = await import("../services/gmb-edit-impact.service"));
});

describe("listEditImpactsForBusiness", () => {
  it("returns an empty array when no baselines exist", async () => {
    const impacts = await listEditImpactsForBusiness("biz-empty");
    expect(impacts).toEqual([]);
  });

  it("returns baselines without summaries when no post snapshot exists yet (pending state)", async () => {
    const now = new Date();
    baselineRows.push({
      id: "snap-1",
      businessId: "biz-1",
      gmbId: "gmb-1",
      actionId: "act-1",
      actionType: "profile_edit",
      phase: "baseline",
      capturedAt: now,
      action: { title: "Updated description", appliedAt: now },
    });

    const impacts = await listEditImpactsForBusiness("biz-1");
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({
      actionId: "act-1",
      actionType: "profile_edit",
      actionTitle: "Updated description",
      postEvaluatedAt: null,
      summary: null,
    });
  });

  it("pairs baseline with post snapshot and surfaces deltaSummary", async () => {
    const baselineDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const postDate = new Date();
    const summary = {
      keywordsImproved: 3,
      keywordsDeclined: 1,
      keywordsUnchanged: 2,
      avgPositionDelta: 4.5,
      topImprovements: [
        { keyword: "shawarma toronto", locationLabel: null, before: 14, after: 6, delta: 8 },
      ],
      topDeclines: [],
    };

    baselineRows.push({
      id: "snap-paired",
      businessId: "biz-paired",
      gmbId: "gmb-paired",
      actionId: "act-paired",
      actionType: "categories_update",
      phase: "baseline",
      capturedAt: baselineDate,
      action: { title: "Category change", appliedAt: baselineDate },
    });
    postRows.push({
      actionId: "act-paired",
      capturedAt: postDate,
      evaluatedAt: postDate,
      deltaSummary: summary,
    });

    const impacts = await listEditImpactsForBusiness("biz-paired");
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.summary).toMatchObject(summary);
    expect(impacts[0]!.postEvaluatedAt).toBe(postDate.toISOString());
  });

  it("handles multiple baselines, some with posts, some without", async () => {
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recentDate = new Date();

    baselineRows.push(
      {
        id: "snap-evaluated",
        businessId: "biz-mixed",
        gmbId: "gmb-mixed",
        actionId: "act-eval",
        actionType: "hours_update",
        phase: "baseline",
        capturedAt: oldDate,
        action: { title: "Hours fix", appliedAt: oldDate },
      },
      {
        id: "snap-pending",
        businessId: "biz-mixed",
        gmbId: "gmb-mixed",
        actionId: "act-pending",
        actionType: "attributes_update",
        phase: "baseline",
        capturedAt: recentDate,
        action: { title: "Attribute fill-in", appliedAt: recentDate },
      },
    );
    postRows.push({
      actionId: "act-eval",
      capturedAt: recentDate,
      evaluatedAt: recentDate,
      deltaSummary: { keywordsImproved: 2 },
    });

    const impacts = await listEditImpactsForBusiness("biz-mixed");
    expect(impacts).toHaveLength(2);
    const evaluated = impacts.find((i) => i.actionId === "act-eval")!;
    const pending = impacts.find((i) => i.actionId === "act-pending")!;
    expect(evaluated.summary).not.toBeNull();
    expect(pending.summary).toBeNull();
  });
});
