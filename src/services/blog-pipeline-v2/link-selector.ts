import { createHash } from "node:crypto";
import OpenAI from "openai";

import { prisma as defaultPrisma } from "../../config/db.config";
import { EMBEDDING_MODEL, indexName, pc } from "../../config/pinecone.config";
import { filterAliveUrls } from "../../utils/link-validator";
import { urlMatchesManagedWebsite } from "../../utils/managed-backlinks.utils";
import { ProductionPipelineUsageRecorder } from "./usage-accounting";

export const BLOG_PIPELINE_V2_MANAGED_LINK_MINIMUM_SCORE = 0.64;

export type ProductionLinkCandidate = {
  kind: "internal" | "managed_backlink";
  title: string;
  url: string;
  businessId: string;
  score: number;
};

type PineconeCandidate = Omit<ProductionLinkCandidate, "kind"> & {
  namespace: "blogs" | "sitemaps" | "business-profiles";
};

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, "");
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function titleFromUrl(raw: string): string {
  const url = new URL(raw);
  return (
    url.pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/[-_]+/g, " ")
      .trim() || url.hostname.replace(/^www\./, "")
  );
}

function fromMatches(
  response: any,
  namespace: PineconeCandidate["namespace"],
): PineconeCandidate[] {
  return (response?.matches ?? []).flatMap((match: any) => {
    const metadata = match?.metadata ?? {};
    const rawUrl =
      namespace === "business-profiles" ? metadata.website_url : metadata.url;
    const url = normalizeUrl(typeof rawUrl === "string" ? rawUrl : "");
    const businessId =
      typeof metadata.business_id === "string" ? metadata.business_id : "";
    if (!url || !businessId) return [];
    const title =
      (typeof metadata.title === "string" && metadata.title.trim()) ||
      (typeof metadata.business_name === "string" &&
        metadata.business_name.trim()) ||
      titleFromUrl(url);
    return [
      {
        title: title.slice(0, 200),
        url,
        businessId,
        score: Number(match.score) || 0,
        namespace,
      },
    ];
  });
}

function unique(candidates: PineconeCandidate[]): PineconeCandidate[] {
  const values = new Map<string, PineconeCandidate>();
  for (const candidate of candidates) {
    const current = values.get(candidate.url);
    if (!current || candidate.score > current.score) {
      values.set(candidate.url, candidate);
    }
  }
  return [...values.values()].sort((left, right) => right.score - left.score);
}

const STOP_WORDS = new Set([
  "and",
  "are",
  "best",
  "for",
  "from",
  "how",
  "near",
  "the",
  "this",
  "what",
  "with",
  "your",
]);

function topicTokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .map((token) => token.replace(/(?:es|s)$/i, ""))
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
  );
}

function descriptiveAndRelevant(candidate: PineconeCandidate, keyword: string): boolean {
  const titleTokens = topicTokens(candidate.title);
  if (titleTokens.size < 2) return false;
  const keywordTokens = topicTokens(keyword);
  const overlap = [...titleTokens].filter((token) => keywordTokens.has(token)).length;
  return overlap >= 2 || candidate.score >= BLOG_PIPELINE_V2_MANAGED_LINK_MINIMUM_SCORE;
}

function usableInternalCandidate(
  candidate: Pick<ProductionLinkCandidate, "title" | "url" | "businessId" | "score">,
  input: { businessId: string; websiteUrl: string; keyword: string },
): boolean {
  const candidateUrl = normalizeUrl(candidate.url);
  const officialUrl = normalizeUrl(input.websiteUrl);
  if (
    !candidateUrl ||
    !officialUrl ||
    candidate.businessId !== input.businessId ||
    candidateUrl === officialUrl ||
    !urlMatchesManagedWebsite(candidateUrl, officialUrl)
  ) {
    return false;
  }
  const title = candidate.title.trim();
  if (
    /^(?:about(?: us)?|blog|contact(?: us)?|home|index|news|services?|website)$/i.test(
      title,
    )
  ) {
    return false;
  }
  const titleTokens = topicTokens(title);
  if (titleTokens.size < 2) return false;
  const keywordTokens = topicTokens(input.keyword);
  const overlap = [...titleTokens].filter((token) => keywordTokens.has(token)).length;
  return overlap >= 1 || Number(candidate.score) >= 0.35;
}

export function filterProductionLinkCandidates(input: {
  candidates: ProductionLinkCandidate[];
  businessId: string;
  websiteUrl: string;
  keyword: string;
}): ProductionLinkCandidate[] {
  const seen = new Set<string>();
  return input.candidates.flatMap((candidate) => {
    const url = normalizeUrl(candidate.url);
    if (!url || seen.has(url)) return [];
    const normalized = { ...candidate, url };
    const usable =
      candidate.kind === "internal"
        ? usableInternalCandidate(normalized, input)
        : candidate.businessId !== input.businessId &&
          Number(candidate.score) >= BLOG_PIPELINE_V2_MANAGED_LINK_MINIMUM_SCORE &&
          descriptiveAndRelevant(
            { ...normalized, namespace: "business-profiles" },
            input.keyword,
          );
    if (!usable) return [];
    seen.add(url);
    return [normalized];
  });
}

export async function selectProductionBlogLinks(input: {
  planId: string;
  businessId: string;
  websiteUrl: string;
  keyword: string;
  preferredInternalCandidates?: ProductionLinkCandidate[];
  recorder: ProductionPipelineUsageRecorder;
  prisma?: typeof defaultPrisma;
  openai?: OpenAI;
}): Promise<ProductionLinkCandidate[]> {
  if (!process.env.PINECONE_API_KEY?.trim()) {
    throw new Error("PINECONE_API_KEY is required for production blog link selection");
  }
  const prisma = input.prisma ?? defaultPrisma;
  const openai =
    input.openai ??
    new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
  let embeddingResponse: any;
  try {
    embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: input.keyword.replace(/\s+/g, " ").trim(),
    });
  } catch (error) {
    await input.recorder.recordFailure({
      stage: "embedding",
      provider: "openai",
      model: EMBEDDING_MODEL,
      attempt: 1,
      error,
    });
    throw error;
  }
  const vector = embeddingResponse.data?.[0]?.embedding;
  if (!vector?.length) throw new Error("OpenAI returned no link embedding");
  const inputTokens = Number(embeddingResponse.usage?.prompt_tokens ?? 0);
  const providerResponseId =
    String(embeddingResponse._request_id ?? "").trim() ||
    `embedding-${createHash("sha256").update(JSON.stringify(vector)).digest("hex")}`;
  await input.recorder.recordFixedCost({
    stage: "embedding",
    provider: "openai",
    model: EMBEDDING_MODEL,
    responseId: providerResponseId,
    inputTokens,
    totalTokens: Number(embeddingResponse.usage?.total_tokens ?? inputTokens),
    estimatedUsd: (inputTokens / 1_000_000) * 0.02,
    metadata: { kind: "embedding", embeddingCalls: 1, pineconeWrites: 0 },
  });

  const request = (filter: Record<string, unknown>, topK = 12) => ({
    vector,
    topK,
    includeMetadata: true,
    filter,
  });
  const index = pc.index(indexName);
  const [internalBlogs, internalSitemaps, externalBlogs, externalSitemaps, profiles] =
    await Promise.all([
      index.namespace("blogs").query(request({ business_id: { $eq: input.businessId } })),
      index.namespace("sitemaps").query(request({ business_id: { $eq: input.businessId } })),
      index.namespace("blogs").query(request({ business_id: { $ne: input.businessId } }, 24)),
      index.namespace("sitemaps").query(request({ business_id: { $ne: input.businessId } }, 24)),
      index.namespace("business-profiles").query(
        request({ business_id: { $ne: input.businessId } }, 32),
      ),
    ]);
  const officialUrl = normalizeUrl(input.websiteUrl);
  if (!officialUrl) throw new Error("Business website URL is invalid");

  const internalRanked = unique([
    ...(input.preferredInternalCandidates ?? [])
      .filter((candidate) => candidate.kind === "internal")
      .map((candidate) => ({
        title: candidate.title,
        url: candidate.url,
        businessId: candidate.businessId,
        score: candidate.score,
        namespace: "sitemaps" as const,
      })),
    ...fromMatches(internalBlogs, "blogs"),
    ...fromMatches(internalSitemaps, "sitemaps"),
  ]).filter(
    (candidate) =>
      usableInternalCandidate(candidate, {
        businessId: input.businessId,
        websiteUrl: input.websiteUrl,
        keyword: input.keyword,
      }),
  );
  const internalAlive = await filterAliveUrls(internalRanked.slice(0, 12), 5);
  const internal = internalAlive.slice(0, 4).map((candidate) => ({
    kind: "internal" as const,
    title: candidate.title,
    url: candidate.url,
    businessId: candidate.businessId,
    score: candidate.score,
  }));

  const activeBusinesses = await prisma.business.findMany({
    where: {
      isActive: true,
      websiteStatus: "active",
      businessWebsiteUrl: { not: "" },
    },
    select: { id: true, businessWebsiteUrl: true },
  });
  const businessById = new Map(activeBusinesses.map((row) => [row.id, row]));
  const externalRanked = unique([
    ...fromMatches(externalBlogs, "blogs"),
    ...fromMatches(externalSitemaps, "sitemaps"),
    ...fromMatches(profiles, "business-profiles"),
  ]).filter((candidate) => {
    const target = businessById.get(candidate.businessId);
    return Boolean(
      candidate.businessId !== input.businessId &&
        candidate.score >= BLOG_PIPELINE_V2_MANAGED_LINK_MINIMUM_SCORE &&
        target?.businessWebsiteUrl &&
        urlMatchesManagedWebsite(candidate.url, target.businessWebsiteUrl) &&
        !urlMatchesManagedWebsite(candidate.url, input.websiteUrl) &&
        descriptiveAndRelevant(candidate, input.keyword),
    );
  });
  const externalAlive = await filterAliveUrls(externalRanked.slice(0, 12), 4);
  const managed = externalAlive.slice(0, 1).map((candidate) => ({
    kind: "managed_backlink" as const,
    title: candidate.title,
    url: candidate.url,
    businessId: candidate.businessId,
    score: candidate.score,
  }));
  return filterProductionLinkCandidates({
    candidates: [...internal, ...managed],
    businessId: input.businessId,
    websiteUrl: input.websiteUrl,
    keyword: input.keyword,
  });
}
