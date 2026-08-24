import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { prisma } from "../config/db.config";
import {
  tryAcquirePublishLock,
  releasePublishLock,
} from "../services/publishing.service";
import { ConnectionPlatform } from "@prisma/client";
import { randomUUID } from "crypto";

describe("Publish lock", () => {
  let blogId: string;
  let integrationId: string;
  let userId: string;
  let businessId: string;
  let metaId: string;
  let customFieldId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      where: {},
      select: { id: true },
    });
    if (!user) throw new Error("No user in DB");
    userId = user.id;

    const business = await prisma.business.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!business) throw new Error("No business in DB");
    businessId = business.id;

    metaId = randomUUID();
    customFieldId = randomUUID();
    await prisma.meta.create({
      data: {
        id: metaId,
        seo_title: "Test",
        seo_description: "Test",
        focus_keyword: "test",
        keywords: [],
      },
    });
    await prisma.customField.create({
      data: {
        id: customFieldId,
        reading_time: "1 min",
        rating: 5,
      },
    });

    const blog = await prisma.blog.create({
      data: {
        title: "Lock Test",
        slug: `lock-test-${randomUUID().slice(0, 8)}`,
        content: "<p>Test</p>",
        excerpt: "Test",
        status: "DRAFT",
        featured_media: "",
        blogPublishTime: "10:00",
        blogPublishDate: "2026-01-01",
        userId,
        businessId,
        metaId,
        customFieldId,
      },
    });
    blogId = blog.id;

    const integration = await prisma.publishingIntegration.create({
      data: {
        userId,
        businessId,
        platform: ConnectionPlatform.WORDPRESS,
        isActive: true,
        autoPublish: false,
        publishAs: "PUBLISH",
        wordpressUrl: "https://example.com",
        wordpressConnectionMethod: "PLUGIN",
      },
    });
    integrationId = integration.id;
  });

  afterAll(async () => {
    await prisma.publishedBlog
      .deleteMany({ where: { blogId, integrationId } })
      .catch(() => {});
    await prisma.publishingIntegration.deleteMany({ where: { id: integrationId } }).catch(() => {});
    await prisma.blog.deleteMany({ where: { id: blogId } }).catch(() => {});
    await prisma.meta.deleteMany({ where: { id: metaId } }).catch(() => {});
    await prisma.customField.deleteMany({ where: { id: customFieldId } }).catch(() => {});
  });

  it("allows only one in-flight publish per (blogId, integrationId)", async () => {
    await releasePublishLock(blogId, integrationId);

    const attempt1 = `${blogId}:${integrationId}:${Date.now()}-a`;
    const attempt2 = `${blogId}:${integrationId}:${Date.now()}-b`;

    const r1 = await tryAcquirePublishLock(
      blogId,
      integrationId,
      attempt1,
      ConnectionPlatform.WORDPRESS,
    );
    expect(r1.acquired).toBe(true);

    const r2 = await tryAcquirePublishLock(
      blogId,
      integrationId,
      attempt2,
      ConnectionPlatform.WORDPRESS,
    );
    expect(r2.acquired).toBe(false);
    expect(r2.alreadyPublishing).toBe(true);

    await releasePublishLock(blogId, integrationId);

    const r3 = await tryAcquirePublishLock(
      blogId,
      integrationId,
      attempt2,
      ConnectionPlatform.WORDPRESS,
    );
    expect(r3.acquired).toBe(true);
  });

  it("recovers stale lock after expiry", async () => {
    await tryAcquirePublishLock(
      blogId,
      integrationId,
      `${blogId}:${integrationId}:stale`,
      ConnectionPlatform.WORDPRESS,
    );

    await prisma.publishedBlog.updateMany({
      where: { blogId, integrationId },
      data: {
        publishLockExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const r = await tryAcquirePublishLock(
      blogId,
      integrationId,
      `${blogId}:${integrationId}:${Date.now()}`,
      ConnectionPlatform.WORDPRESS,
    );
    expect(r.acquired).toBe(true);
    expect(r.staleRecovered).toBe(true);

    await releasePublishLock(blogId, integrationId);
  });
});
