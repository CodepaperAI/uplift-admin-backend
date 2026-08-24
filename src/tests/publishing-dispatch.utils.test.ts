import { PublishStatus } from "@prisma/client";
import { describe, expect, it } from "bun:test";
import { getBlogDispatchDecision } from "../utils/publishing-dispatch.utils";

describe("publishing dispatch utils", () => {
  it("queues CMS publishing when an active integration is still missing dispatch", () => {
    const decision = getBlogDispatchDecision({
      activeIntegrationIds: ["integration-a", "integration-b"],
      publishedBlogs: [
        {
          integrationId: "integration-a",
          status: PublishStatus.PUBLISHED,
        },
      ],
      hasGmbConnection: false,
      gmbPostStatuses: [],
    });

    expect(decision).toEqual({
      needsAutoPublish: true,
      needsGmb: false,
      status: "queued",
    });
  });

  it("queues only GMB when CMS is already dispatched but GMB is not", () => {
    const decision = getBlogDispatchDecision({
      activeIntegrationIds: ["integration-a"],
      publishedBlogs: [
        {
          integrationId: "integration-a",
          status: PublishStatus.PUBLISHING,
        },
      ],
      hasGmbConnection: true,
      gmbPostStatuses: [],
    });

    expect(decision).toEqual({
      needsAutoPublish: false,
      needsGmb: true,
      status: "queued",
    });
  });

  it("queues both CMS and GMB when both are still outstanding", () => {
    const decision = getBlogDispatchDecision({
      activeIntegrationIds: ["integration-a"],
      publishedBlogs: [],
      hasGmbConnection: true,
      gmbPostStatuses: [],
    });

    expect(decision).toEqual({
      needsAutoPublish: true,
      needsGmb: true,
      status: "queued",
    });
  });

  it("reports already dispatched when CMS and GMB have already been queued or published", () => {
    const decision = getBlogDispatchDecision({
      activeIntegrationIds: ["integration-a"],
      publishedBlogs: [
        {
          integrationId: "integration-a",
          status: PublishStatus.PENDING,
        },
      ],
      hasGmbConnection: true,
      gmbPostStatuses: ["SCHEDULED"],
    });

    expect(decision).toEqual({
      needsAutoPublish: false,
      needsGmb: false,
      status: "already_dispatched",
    });
  });

  it("ignores unrelated publish records when deciding whether a CMS integration still needs dispatch", () => {
    const decision = getBlogDispatchDecision({
      activeIntegrationIds: ["integration-a"],
      publishedBlogs: [
        {
          integrationId: "integration-b",
          status: PublishStatus.PUBLISHED,
        },
      ],
      hasGmbConnection: false,
      gmbPostStatuses: [],
    });

    expect(decision).toEqual({
      needsAutoPublish: true,
      needsGmb: false,
      status: "queued",
    });
  });
});
