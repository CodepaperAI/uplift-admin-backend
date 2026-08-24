import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";
import { sanitizeManagedCandidateLinks } from "../utils/managed-backlinks.utils";
import { partitionAliveUrls } from "../utils/link-validator";

export const pc = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

export const indexName = "seo-tool";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSION = 1536;

export type BlogPayload = {
  title: string;
  content: string;
  url?: string | null;
  userId: string;
  businessId: string;
  tags: string[];
  categories: string[];
  seoDescription: string;
};

export type CandidateLink = {
  title: string;
  businessId: string;
  url: string;
  score?: number;
};

type SearchScope = "INTERNAL" | "EXTERNAL";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

async function getEmbedding(text: string): Promise<number[]> {
  const cleanedText = text.replace(/\n/g, " ");

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: cleanedText,
    });

    if (!response.data || response.data.length === 0) {
      throw new Error("No embedding returned from OpenAI.");
    }

    return response.data[0]!.embedding;
  } catch (error: any) {
    console.error("Error generating embedding with OpenAI:", error);
    
    if (error?.status === 429 || error?.code === "insufficient_quota") {
      console.warn("⚠️ OpenAI quota exceeded. Embedding generation skipped.");
      throw new Error("OPENAI_QUOTA_EXCEEDED");
    }
    
    throw new Error("Failed to generate embedding vector.");
  }
}

export async function upsertBusinessProfile(
  businessId: string,
  payload: {
    businessDescription: string;
    businessType: string;
    advantage: string[];
    keywords: { keyword: string; keywordType: string }[];
    userId: string;
    websiteURL: string;
    competitors: { name: string; url: string }[];
  },
  businessName: string
) {
  try {
    const fullProfileText = `
      Business Name: ${businessName}.
      Description: ${payload.businessDescription}.
      Type: ${payload.businessType}.
      Website: ${payload.websiteURL}.
      Competitive Advantages: ${payload.advantage.join(", ")}.
      Keywords: ${payload.keywords
        .map((k) => `${k.keyword} (${k.keywordType})`)
        .join(", ")}.
      Competitors: ${payload.competitors
        .map((c) => `${c.name} - ${c.url}`)
        .join(", ")}.
    `;

    const safeText = fullProfileText.slice(0, 8000);

    const embeddingVector = await getEmbedding(safeText);

    const vectorID = `business-profile-${businessId}`;

    const index = pc.index(indexName);
    await index.namespace("business-profiles").upsert({
      records: [
        {
          id: vectorID,
          values: embeddingVector,
          metadata: {
            business_id: businessId,
            business_name: businessName,
            business_type: payload.businessType,
            user_id: payload.userId,
            profile_text: safeText,
            website_url: payload.websiteURL,
          },
        },
      ],
    });
    
    console.log(`✅ Successfully upserted business profile ${businessId} to Pinecone.`);
  } catch (error: any) {
    if (error?.message === "OPENAI_QUOTA_EXCEEDED") {
      console.warn("⚠️ Skipping Pinecone upsert due to OpenAI quota exceeded. Business creation will continue.");
      return;
    }
    console.error("Error upserting business profile to Pinecone:", error);
    throw error;
  }
}

export async function upsertBlog(blogId: string, payload: BlogPayload) {
  try {
    const blogTextForEmbedding = `
      Title: ${payload.title}.
      SEO Description: ${payload.seoDescription}.
      Categories: ${payload.categories.join(", ")}.
      Tags: ${payload.tags.join(", ")}.
      Content: ${payload.content}
    `;

    const safeText = blogTextForEmbedding.slice(0, 8000);

    const embeddingVector = await getEmbedding(safeText);

    const vectorID = `blog-${blogId}`;
    const index = pc.index(indexName);

    const metadata: Record<string, string | number> = {
      blog_id: blogId,
      user_id: payload.userId,
      business_id: payload.businessId,
      title: payload.title,
    };

    if (payload.url) {
      metadata.url = payload.url;
    }

    await index.namespace("blogs").upsert({
      records: [
        {
          id: vectorID,
          values: embeddingVector,
          metadata,
        },
      ],
    });

    console.log(`Successfully upserted blog ${blogId} to Pinecone.`);
  } catch (error) {
    console.error("Error upserting blog to Pinecone:", error);
    throw error;
  }
}

export async function updateBlogUrl(blogId: string, url: string) {
  try {
    const vectorID = `blog-${blogId}`;
    const index = pc.index(indexName);
    
    const fetchResponse = await index.namespace("blogs").fetch({ ids: [vectorID] });
    const existingVector = fetchResponse.records[vectorID];
    
    if (!existingVector) {
      console.warn(`Blog ${blogId} not found in Pinecone, cannot update URL`);
      return;
    }
    
    await index.namespace("blogs").update({
      id: vectorID,
      metadata: {
        ...existingVector.metadata,
        url: url,
      },
    });
    
    console.log(`✅ Updated blog ${blogId} URL in Pinecone: ${url}`);
  } catch (error) {
    console.error(`Error updating blog URL in Pinecone:`, error);
    throw error;
  }
}

export async function upsertSitemapUrls(
  businessId: string,
  userId: string,
  urls: string[]
) {
  if (!urls?.length) {
    console.log("No sitemap URLs to upsert.");
    return;
  }

  const index = pc.index(indexName);
  const namespace = "sitemaps";

  try {
    const vectors: any[] = [];

    for (const url of urls) {
      const text = `Website Page URL: ${url}`;
      const embedding = await getEmbedding(text);

      vectors.push({
        id: `sitemap-${businessId}-${Buffer.from(url).toString("base64")}`,
        values: embedding,
        metadata: { url, business_id: businessId, user_id: userId },
      });
    }

    // Batch safely under 4 MB
    for (let i = 0; i < vectors.length; i += 50) {
      const batch = vectors.slice(i, i + 50);
      if (batch.length === 0) {
        continue;
      }
      await index.namespace(namespace).upsert({ records: batch });
    }

    console.log(
      `✅ Upserted ${vectors.length} sitemap URLs for business ${businessId}.`
    );
  } catch (err) {
    console.error("❌ Error upserting sitemap URLs to Pinecone:", err);
    throw err;
  }
}

/**
 * Deterministic ID used for a sitemap URL vector.
 * Exported so callers can compute the expected ID without going
 * through Pinecone, e.g. for diffing current vs. live sitemaps.
 */
export function buildSitemapVectorId(
  businessId: string,
  url: string,
): string {
  return `sitemap-${businessId}-${Buffer.from(url).toString("base64")}`;
}

/**
 * List every sitemap vector ID currently in Pinecone for a business.
 * Walks pagination until exhausted. Returns an empty array on any error
 * so callers can decide how to handle (typically: skip delete phase).
 */
export async function listSitemapVectorIdsForBusiness(
  businessId: string,
): Promise<string[]> {
  const index = pc.index(indexName);
  const prefix = `sitemap-${businessId}-`;
  const ids: string[] = [];
  let paginationToken: string | undefined = undefined;

  try {
    // Bounded loop; Pinecone pagination is finite but we guard against
    // a runaway token cycle.
    for (let page = 0; page < 100; page++) {
      const response: { vectors?: Array<{ id?: string }>; pagination?: { next?: string } } =
        await index.namespace("sitemaps").listPaginated({
          prefix,
          limit: 100,
          paginationToken,
        });
      for (const v of response.vectors ?? []) {
        if (v.id) ids.push(v.id);
      }
      paginationToken = response.pagination?.next;
      if (!paginationToken) break;
    }
  } catch (err) {
    console.error(
      `[listSitemapVectorIdsForBusiness] failed for business=${businessId}:`,
      err,
    );
    return [];
  }

  return ids;
}

/**
 * Delete a batch of sitemap vectors from Pinecone. No-op on empty input.
 * Chunks into batches of 1000 (Pinecone's deleteMany limit).
 * Errors are logged and rethrown so the caller can track sync failure.
 */
export async function deleteSitemapVectors(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const index = pc.index(indexName);
  const CHUNK = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await index.namespace("sitemaps").deleteMany({ ids: chunk });
  }
}

/**
 * Delete vectors from Pinecone for URLs that failed liveness checks.
 * Groups deletions by namespace and batches them in a single call each.
 * Always resolves — errors are logged but never rethrown, because
 * blog generation must not fail because of an index cleanup hiccup.
 */
async function pruneDeadPineconeVectors(
  index: ReturnType<typeof pc.index>,
  deadLinks: Array<{ _vectorId: string; _namespace: "blogs" | "sitemaps" }>,
): Promise<void> {
  const byNamespace = new Map<"blogs" | "sitemaps", string[]>();
  for (const link of deadLinks) {
    if (!link._vectorId) continue;
    const list = byNamespace.get(link._namespace) ?? [];
    list.push(link._vectorId);
    byNamespace.set(link._namespace, list);
  }

  await Promise.allSettled(
    Array.from(byNamespace.entries()).map(async ([ns, ids]) => {
      if (ids.length === 0) return;
      try {
        await index.namespace(ns).deleteMany({ ids });
        console.log(
          `[pruneDeadPineconeVectors] namespace=${ns} deleted=${ids.length}`,
        );
      } catch (err) {
        console.error(
          `[pruneDeadPineconeVectors] failed for namespace=${ns}:`,
          err,
        );
      }
    }),
  );
}

export async function findRelevantLinks(
  newBlogId: string,
  currentBusinessId: string,
  payload: BlogPayload,
  scope: SearchScope
): Promise<CandidateLink[]> {
  try {
    const blogTextForEmbedding = `Title: ${payload.title}. Content: ${payload.content}`;
    const safeText = blogTextForEmbedding.slice(0, 8000);
    const embeddingVector = await getEmbedding(safeText);

    let filter = {};
    if (scope === "INTERNAL") {
      filter = { business_id: { $eq: currentBusinessId } };
    } else {
      filter = { business_id: { $ne: currentBusinessId } };
    }

    const index = pc.index(indexName);

    const queryRequest = {
      // Over-fetch so we still have enough live candidates after
      // dead-URL filtering (see filterAliveUrls below).
      topK: 8,
      vector: embeddingVector,
      includeMetadata: true,
      filter: filter,
    };

    const [blogResponse, sitemapResponse] = await Promise.all([
      index.namespace("blogs").query(queryRequest),
      index.namespace("sitemaps").query(queryRequest),
    ]);

    // Track the Pinecone vector id + namespace on each candidate so we can
    // prune dead vectors from the index after validation.
    type AnnotatedCandidate = CandidateLink & {
      _vectorId: string;
      _namespace: "blogs" | "sitemaps";
    };

    const allMatches: AnnotatedCandidate[] = [];

    if (blogResponse.matches) {
      const blogMatches = blogResponse.matches
        .filter((match) => match.metadata?.blog_id !== newBlogId)
        .map((match) => ({
          title: match.metadata?.title as string,
          url: match.metadata?.url as string,
          businessId: match.metadata?.business_id as string,
          score: match.score ?? 0,
          _vectorId: match.id,
          _namespace: "blogs" as const,
        }));
      allMatches.push(...blogMatches);
    }

    if (sitemapResponse.matches) {
      const sitemapMatches = sitemapResponse.matches.map((match) => ({
        title: match.metadata?.url as string,
        url: match.metadata?.url as string,
        businessId: match.metadata?.business_id as string,
        score: match.score ?? 0,
        _vectorId: match.id,
        _namespace: "sitemaps" as const,
      }));
      allMatches.push(...sitemapMatches);
    }

    const sortedLinks = sanitizeManagedCandidateLinks(allMatches).sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );

    // Partition into alive vs dead. Only alive links flow to the LLM;
    // dead ones are deleted from Pinecone (fire-and-forget) so they
    // stop surfacing on future queries.
    const { alive: aliveLinks, dead: deadLinks } =
      await partitionAliveUrls(sortedLinks);

    if (
      deadLinks.length > 0 &&
      process.env.PINECONE_DEAD_VECTOR_PRUNE_ENABLED !== "false"
    ) {
      void pruneDeadPineconeVectors(index, deadLinks);
    }

    const pruneQueued =
      process.env.PINECONE_DEAD_VECTOR_PRUNE_ENABLED === "false"
        ? 0
        : deadLinks.length;
    console.log(
      `[findRelevantLinks] scope=${scope} raw=${sortedLinks.length} ` +
        `alive=${aliveLinks.length} dropped=${deadLinks.length} ` +
        `pinecone_prune_queued=${pruneQueued}`
    );

    return aliveLinks
      .slice(0, 10)
      .map(({ title, url, businessId, score }) => ({ title, url, businessId, score }));
  } catch (error) {
    console.error(`Error finding ${scope} links in Pinecone:`, error);
    throw error;
  }
}

export async function findRelevantLinksWithClusterBoost(
  newBlogId: string,
  currentBusinessId: string,
  payload: BlogPayload,
  scope: SearchScope,
  clusterId?: string | null,
): Promise<CandidateLink[]> {
  // Get base results from existing function
  const baseResults = await findRelevantLinks(newBlogId, currentBusinessId, payload, scope);

  // If no cluster context or external links, return as-is
  if (!clusterId || scope === "EXTERNAL") {
    return baseResults;
  }

  // For internal links, boost same-cluster blogs
  // Fetch blog IDs that belong to the same cluster
  const { prisma } = await import("./db.config");
  const sameClusterBlogs = await prisma.blog.findMany({
    where: {
      clusterId: clusterId,
      businessId: currentBusinessId,
    },
    select: { id: true, slug: true, title: true },
  });

  const clusterBlogTitles = new Set(
    sameClusterBlogs.map((b) => b.title.toLowerCase()),
  );

  // Boost scores for same-cluster results by 0.15 (significant but not overwhelming)
  const boostedResults = baseResults.map((link) => {
    const titleLower = link.title.toLowerCase();
    if (clusterBlogTitles.has(titleLower)) {
      return { ...link, score: Math.min(1, (link.score || 0) + 0.15) };
    }
    return link;
  });

  // Re-sort by boosted score
  boostedResults.sort((a, b) => (b.score || 0) - (a.score || 0));

  return boostedResults;
}
