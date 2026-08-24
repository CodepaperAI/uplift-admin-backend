import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient, PublishStatus } from "@prisma/client";

const prisma = createPrismaClient();

interface VerificationResult {
  missingBlogIdPlans: {
    count: number;
    plans: Array<{
      id: string;
      keyword: string;
      userId: string;
      businessId: string | null;
      isUsed: boolean;
      usedAt: Date | null;
      publishDate: string;
    }>;
  };
  duplicateBlogs: {
    count: number;
    duplicates: Array<{
      focusKeyword: string;
      blogCount: number;
      blogIds: string[];
      businessId: string | null;
    }>;
  };
  stuckPublishing: {
    count: number;
    records: Array<{
      id: string;
      blogId: string;
      integrationId: string;
      platform: string;
      status: string;
      publishingStartedAt: Date | null;
      lastError: string | null;
    }>;
  };
  summary: {
    totalPlansWithMissingBlogId: number;
    totalDuplicateBlogGroups: number;
    totalStuckPublishingRecords: number;
    issues: string[];
  };
}

async function verifyBlogPublishing(): Promise<VerificationResult> {
  console.log("🔍 Starting Blog Publishing Verification...\n");

  const result: VerificationResult = {
    missingBlogIdPlans: { count: 0, plans: [] },
    duplicateBlogs: { count: 0, duplicates: [] },
    stuckPublishing: { count: 0, records: [] },
    summary: {
      totalPlansWithMissingBlogId: 0,
      totalDuplicateBlogGroups: 0,
      totalStuckPublishingRecords: 0,
      issues: [],
    },
  };

  console.log("📋 Step 1: Checking for Plan records with isUsed=true but blogId is null...");
  const missingBlogIdPlans = await prisma.plan.findMany({
    where: {
      isUsed: true,
      blogId: null,
      deletedAt: null,
    },
    select: {
      id: true,
      keyword: true,
      userId: true,
      businessId: true,
      isUsed: true,
      usedAt: true,
      publishDate: true,
    },
    orderBy: { usedAt: "desc" },
    take: 50,
  });

  result.missingBlogIdPlans = {
    count: missingBlogIdPlans.length,
    plans: missingBlogIdPlans,
  };
  result.summary.totalPlansWithMissingBlogId = missingBlogIdPlans.length;

  if (missingBlogIdPlans.length > 0) {
    result.summary.issues.push(
      `Found ${missingBlogIdPlans.length} Plan records marked as used but missing blogId`
    );
    console.log(
      `   ⚠️ Found ${missingBlogIdPlans.length} Plan records marked as used but missing blogId`
    );
    console.log("   Sample keywords:");
    missingBlogIdPlans.slice(0, 5).forEach((p) => {
      console.log(`      - "${p.keyword}" (ID: ${p.id})`);
    });
  } else {
    console.log("   ✅ No issues found - all used Plans have blogId set");
  }

  console.log("\n📋 Step 2: Checking for duplicate blogs with same focus_keyword...");
  const allBlogsWithFocusKeyword = await prisma.blog.findMany({
    where: {
      meta: {
        focus_keyword: { not: "" },
      },
    },
    select: {
      id: true,
      businessId: true,
      meta: {
        select: {
          focus_keyword: true,
        },
      },
    },
  });

  const keywordGroups: Record<
    string,
    { blogIds: string[]; businessId: string | null }
  > = {};
  
  for (const blog of allBlogsWithFocusKeyword) {
    const key = `${blog.meta.focus_keyword}::${blog.businessId || "null"}`;
    if (!keywordGroups[key]) {
      keywordGroups[key] = { blogIds: [], businessId: blog.businessId || null };
    }
    keywordGroups[key].blogIds.push(blog.id);
  }

  const duplicates = Object.entries(keywordGroups)
    .filter(([, group]) => group.blogIds.length > 1)
    .map(([key, group]) => ({
      focusKeyword: key.split("::")[0] ?? "",
      blogCount: group.blogIds.length,
      blogIds: group.blogIds,
      businessId: group.businessId,
    }));

  result.duplicateBlogs = {
    count: duplicates.length,
    duplicates: duplicates.slice(0, 20),
  };
  result.summary.totalDuplicateBlogGroups = duplicates.length;

  if (duplicates.length > 0) {
    const totalDuplicatePosts = duplicates.reduce((sum, d) => sum + d.blogCount - 1, 0);
    result.summary.issues.push(
      `Found ${duplicates.length} keyword groups with duplicate blogs (${totalDuplicatePosts} extra posts)`
    );
    console.log(
      `   ⚠️ Found ${duplicates.length} keyword groups with duplicate blogs`
    );
    console.log("   Sample duplicates:");
    duplicates.slice(0, 5).forEach((d) => {
      console.log(
        `      - "${d.focusKeyword}": ${d.blogCount} blogs (IDs: ${d.blogIds.join(", ")})`
      );
    });
  } else {
    console.log("   ✅ No duplicate blogs found");
  }

  console.log("\n📋 Step 3: Checking for PublishedBlog records stuck in PUBLISHING status...");
  const stuckPublishing = await prisma.publishedBlog.findMany({
    where: {
      status: PublishStatus.PUBLISHING,
      publishingStartedAt: {
        lt: new Date(Date.now() - 15 * 60 * 1000),
      },
    },
    select: {
      id: true,
      blogId: true,
      integrationId: true,
      platform: true,
      status: true,
      publishingStartedAt: true,
      lastError: true,
    },
    orderBy: { publishingStartedAt: "desc" },
    take: 50,
  });

  result.stuckPublishing = {
    count: stuckPublishing.length,
    records: stuckPublishing,
  };
  result.summary.totalStuckPublishingRecords = stuckPublishing.length;

  if (stuckPublishing.length > 0) {
    result.summary.issues.push(
      `Found ${stuckPublishing.length} PublishedBlog records stuck in PUBLISHING status`
    );
    console.log(
      `   ⚠️ Found ${stuckPublishing.length} PublishedBlog records stuck in PUBLISHING status`
    );
    console.log("   Sample records:");
    stuckPublishing.slice(0, 5).forEach((r) => {
      console.log(
        `      - Blog ${r.blogId} on ${r.platform}: started ${r.publishingStartedAt?.toISOString()}`
      );
    });
  } else {
    console.log("   ✅ No stuck publishing records found");
  }

  console.log("\n📋 Step 4: Additional checks...");
  
  const pendingOldRecords = await prisma.publishedBlog.count({
    where: {
      status: PublishStatus.PENDING,
      createdAt: {
        lt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    },
  });

  if (pendingOldRecords > 0) {
    result.summary.issues.push(
      `Found ${pendingOldRecords} PublishedBlog records in PENDING status for over 24 hours`
    );
    console.log(
      `   ⚠️ Found ${pendingOldRecords} PublishedBlog records in PENDING status for over 24 hours`
    );
  }

  const failedRecords = await prisma.publishedBlog.count({
    where: {
      status: PublishStatus.FAILED,
      updatedAt: {
        gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    },
  });

  if (failedRecords > 0) {
    console.log(`   ℹ️ Found ${failedRecords} FAILED publishing records in the last 7 days`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 VERIFICATION SUMMARY");
  console.log("=".repeat(60));

  if (result.summary.issues.length === 0) {
    console.log("✅ No issues detected! All systems appear healthy.");
  } else {
    console.log(`⚠️ Found ${result.summary.issues.length} issue(s):\n`);
    result.summary.issues.forEach((issue, idx) => {
      console.log(`   ${idx + 1}. ${issue}`);
    });
  }

  console.log("\n📈 Statistics:");
  console.log(`   - Plans with missing blogId: ${result.summary.totalPlansWithMissingBlogId}`);
  console.log(`   - Duplicate blog groups: ${result.summary.totalDuplicateBlogGroups}`);
  console.log(`   - Stuck publishing records: ${result.summary.totalStuckPublishingRecords}`);

  return result;
}

async function main(): Promise<void> {
  try {
    const result = await verifyBlogPublishing();
    console.log("\n📄 Full Results (JSON):");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("❌ Verification failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
