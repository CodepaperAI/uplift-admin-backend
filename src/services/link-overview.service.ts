import { prisma } from "../config/db.config";
import { buildLinkOverview } from "../utils/link-overview.utils";

export async function getLinkOverviewForBusiness(businessId: string) {
  const [business, blogs, managedBacklinks] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { businessWebsiteUrl: true },
    }),
    prisma.blog.findMany({
      where: { businessId },
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        content: true,
        canonicalUrl: true,
        updatedAt: true,
        publishedBlogs: {
          select: { externalPostUrl: true },
          orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.backlinks.findMany({
      where: {
        referredBusinessId: businessId,
        sourceBusinessId: { not: businessId },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return buildLinkOverview({
    businessWebsiteUrl: business?.businessWebsiteUrl ?? "",
    blogs,
    managedBacklinks,
  });
}
