import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient } from "@prisma/client";
import {
  inferBusinessTimeZone,
} from "../utils/blog-schedule.utils";

const prisma = createPrismaClient();

async function auditPublishingReadiness() {
  const now = new Date();
  const todayUtc = now.toISOString().split("T")[0] ?? "";

  console.log(`\n📋 Publishing Readiness Audit — ${todayUtc}\n`);
  console.log("=".repeat(70));

  // ──────────────────────────────────────────────
  // 1. Active businesses with NO auto-publish integration
  // ──────────────────────────────────────────────
  const activeBusinesses = await prisma.business.findMany({
    where: { isActive: true },
    select: {
      id: true,
      businessName: true,
      userId: true,
      businessCity: true,
      businessState: true,
      businessCountry: true,
      defaultLocale: true,
    },
  });

  const autoPublishIntegrations = await prisma.publishingIntegration.findMany({
    where: { isActive: true, autoPublish: true },
    select: { businessId: true, platform: true, wordpressUrl: true },
  });

  const businessesWithAutoPublish = new Set(
    autoPublishIntegrations.map((i) => i.businessId),
  );

  const noAutoPublish = activeBusinesses.filter(
    (b) => !businessesWithAutoPublish.has(b.id),
  );

  console.log(
    `\n❌ Active businesses with NO auto-publish integration: ${noAutoPublish.length}`,
  );
  for (const b of noAutoPublish.slice(0, 20)) {
    console.log(`   • ${b.businessName} (${b.id}) — user: ${b.userId}`);
  }
  if (noAutoPublish.length > 20) {
    console.log(`   ... and ${noAutoPublish.length - 20} more`);
  }

  // ──────────────────────────────────────────────
  // 2. WordPress integrations with autoPublish=true but missing wordpressUrl
  // ──────────────────────────────────────────────
  const wpMissingUrl = await prisma.publishingIntegration.findMany({
    where: {
      platform: "WORDPRESS",
      isActive: true,
      autoPublish: true,
      OR: [
        { wordpressUrl: null },
        { wordpressUrl: "" },
      ],
    },
    select: {
      id: true,
      businessId: true,
      userId: true,
      wordpressConnectionMethod: true,
      wordpressIntegrationKey: true,
    },
  });

  console.log(
    `\n⚠️  WordPress integrations with autoPublish=true but missing wordpressUrl: ${wpMissingUrl.length}`,
  );
  for (const i of wpMissingUrl) {
    console.log(
      `   • integration: ${i.id} | business: ${i.businessId} | method: ${i.wordpressConnectionMethod} | hasKey: ${!!i.wordpressIntegrationKey}`,
    );
  }

  // ──────────────────────────────────────────────
  // 3. Businesses falling back to default timezone (weak location data)
  // ──────────────────────────────────────────────
  const fallbackTimezoneBusinesses: Array<{
    id: string;
    name: string;
    resolvedTz: string;
    source: string;
    city: string | null;
    state: string | null;
    country: string | null;
  }> = [];

  for (const b of activeBusinesses) {
    const { timeZone, source } = inferBusinessTimeZone({
      defaultLocale: b.defaultLocale,
      businessCountry: b.businessCountry,
      businessState: b.businessState,
      businessCity: b.businessCity,
    });

    if (
      source.startsWith("country-default:") ||
      source.startsWith("locale:") ||
      source === "fallback:UTC"
    ) {
      fallbackTimezoneBusinesses.push({
        id: b.id,
        name: b.businessName,
        resolvedTz: timeZone,
        source,
        city: b.businessCity,
        state: b.businessState,
        country: b.businessCountry,
      });
    }
  }

  console.log(
    `\n🌐 Businesses using FALLBACK timezone (weak/missing location): ${fallbackTimezoneBusinesses.length}`,
  );
  for (const b of fallbackTimezoneBusinesses.slice(0, 20)) {
    console.log(
      `   • ${b.name} (${b.id}) → ${b.resolvedTz} [${b.source}] | city: ${b.city || "—"} state: ${b.state || "—"} country: ${b.country || "—"}`,
    );
  }
  if (fallbackTimezoneBusinesses.length > 20) {
    console.log(
      `   ... and ${fallbackTimezoneBusinesses.length - 20} more`,
    );
  }

  // ──────────────────────────────────────────────
  // 4. Today's due blogs with status
  // ──────────────────────────────────────────────
  const todaysKeywords = await prisma.plan.findMany({
    where: {
      publishDate: todayUtc,
      deletedAt: null,
    },
    select: {
      id: true,
      keyword: true,
      publishDate: true,
      publishTime: true,
      blogId: true,
      userId: true,
      businessId: true,
      business: {
        select: {
          businessName: true,
          isActive: true,
        },
      },
    },
    orderBy: { publishTime: "asc" },
  });

  const generated = todaysKeywords.filter((k) => k.blogId);
  const notGenerated = todaysKeywords.filter((k) => !k.blogId);
  const inactiveBusiness = todaysKeywords.filter(
    (k) => k.business && !k.business.isActive,
  );

  console.log(`\n📅 Today's keywords (${todayUtc}): ${todaysKeywords.length}`);
  console.log(`   ✅ Generated (has blogId): ${generated.length}`);
  console.log(`   ⏳ Not generated yet: ${notGenerated.length}`);
  console.log(`   🚫 Inactive business: ${inactiveBusiness.length}`);

  // Check publish status for generated blogs
  if (generated.length > 0) {
    const blogIds = generated
      .map((k) => k.blogId)
      .filter((id): id is string => id !== null);

    const publishedBlogs = await prisma.publishedBlog.findMany({
      where: { blogId: { in: blogIds } },
      select: {
        blogId: true,
        status: true,
        platform: true,
        lastError: true,
        externalPostUrl: true,
      },
    });

    const publishedMap = new Map<
      string,
      typeof publishedBlogs
    >();
    for (const pb of publishedBlogs) {
      const list = publishedMap.get(pb.blogId) || [];
      list.push(pb);
      publishedMap.set(pb.blogId, list);
    }

    let publishedCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let noIntegrationCount = 0;

    for (const k of generated) {
      const records = publishedMap.get(k.blogId!) || [];
      if (records.length === 0) {
        noIntegrationCount++;
      } else {
        for (const r of records) {
          if (r.status === "PUBLISHED") publishedCount++;
          else if (r.status === "FAILED") failedCount++;
          else pendingCount++;
        }
      }
    }

    console.log(`\n📤 Publish status for today's generated blogs:`);
    console.log(`   ✅ Published: ${publishedCount}`);
    console.log(`   ❌ Failed: ${failedCount}`);
    console.log(`   ⏳ Pending/Publishing: ${pendingCount}`);
    console.log(
      `   🔇 No publish record (no integration): ${noIntegrationCount}`,
    );

    // Show failed details
    const failedRecords = publishedBlogs.filter(
      (pb) => pb.status === "FAILED",
    );
    if (failedRecords.length > 0) {
      console.log(`\n   Failed publish details:`);
      for (const f of failedRecords.slice(0, 10)) {
        console.log(
          `   • blog: ${f.blogId} | platform: ${f.platform} | error: ${f.lastError || "unknown"}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────
  // 5. Not-generated keywords for today — failure reasons
  // ──────────────────────────────────────────────
  if (notGenerated.length > 0) {
    console.log(`\n⏳ Not-generated keywords breakdown:`);

    for (const k of notGenerated.slice(0, 15)) {
      const reasons: string[] = [];

      if (!k.businessId) {
        reasons.push("no businessId");
      } else if (!k.business?.isActive) {
        reasons.push("business inactive");
      }

      if (k.businessId && businessesWithAutoPublish.has(k.businessId)) {
        // has integration, that's fine
      } else if (k.businessId) {
        reasons.push("no auto-publish integration");
      }

      // Check subscription
      const ws = k.businessId
        ? await prisma.websiteSubscription.findUnique({
            where: { businessId: k.businessId },
            select: { status: true, trialStatus: true, trialEndDate: true },
          })
        : null;

      if (!ws) {
        reasons.push("no website subscription");
      } else if (
        ws.status !== "active" &&
        !(
          ws.trialStatus === "trialing" &&
          ws.trialEndDate &&
          ws.trialEndDate > now
        )
      ) {
        reasons.push(`subscription: ${ws.status}, trial: ${ws.trialStatus}`);
      }

      console.log(
        `   • "${k.keyword}" @ ${k.publishTime} | business: ${k.business?.businessName || k.businessId || "—"} | ${reasons.length > 0 ? reasons.join(", ") : "awaiting generation"}`,
      );
    }
    if (notGenerated.length > 15) {
      console.log(`   ... and ${notGenerated.length - 15} more`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("Audit complete.\n");

  await prisma.$disconnect();
}

auditPublishingReadiness().catch((error) => {
  console.error("Audit failed:", error);
  prisma.$disconnect();
  process.exit(1);
});
