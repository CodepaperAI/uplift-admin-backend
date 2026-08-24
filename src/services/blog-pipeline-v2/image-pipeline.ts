import { createHash } from "node:crypto";
import { load } from "cheerio";

import {
  uploadBase64Image,
  uploadImageBuffer,
} from "../../lib/image-storage";
import { fetchPublicResource } from "../social-creative/safe-fetch";
import {
  BLOG_PIPELINE_V2_IMAGE_COUNT,
  BLOG_PIPELINE_V2_IMAGE_MODEL,
  BLOG_PIPELINE_V2_IMAGE_QUALITY,
  BLOG_PIPELINE_V2_IMAGE_SIZE,
} from "./constants";
import {
  runProductionDurableStep,
  type ProductionDurableStepRunner,
} from "./durable-step";
import {
  ProductionPipelineUsageRecorder,
  type PipelineUsageStage,
} from "./usage-accounting";

export type ProductionBlogImageRole =
  | "featured"
  | "internal-1"
  | "internal-2";

export type ProductionBlogImage = {
  role: ProductionBlogImageRole;
  url: string;
  altText: string;
  prompt: string;
  model: typeof BLOG_PIPELINE_V2_IMAGE_MODEL;
  quality: typeof BLOG_PIPELINE_V2_IMAGE_QUALITY;
  size: typeof BLOG_PIPELINE_V2_IMAGE_SIZE;
  providerResponseId: string;
};

const ALL_PRODUCTION_BLOG_IMAGE_ROLES: readonly ProductionBlogImageRole[] = [
  "featured",
  "internal-1",
  "internal-2",
];

export function getProductionBlogImageRoles(
  featuredImageOnly = false,
): ProductionBlogImageRole[] {
  return featuredImageOnly
    ? ["featured"]
    : [...ALL_PRODUCTION_BLOG_IMAGE_ROLES];
}

const ROLE_STAGE: Record<ProductionBlogImageRole, PipelineUsageStage> = {
  featured: "featured_image",
  "internal-1": "internal_image_1",
  "internal-2": "internal_image_2",
};

function imageCostUsd(): number {
  const configured = Number(
    process.env.BLOG_PIPELINE_V2_GPT_IMAGE_2_MEDIUM_1536X1024_USD ?? "",
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 0.0412;
}

function cleanText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export type ProductionBlogEditorialImageBrief = {
  role: ProductionBlogImageRole;
  visualDescription: string;
  altText: string;
};

export function buildProductionBlogImageBriefs(input: {
  title: string;
  keyword: string;
  businessName: string;
  locale: string;
  content: string;
  editorialBriefs?: ProductionBlogEditorialImageBrief[];
}): Array<{ role: ProductionBlogImageRole; altText: string; prompt: string }> {
  const $ = load(input.content, null, false);
  const sectionHeadings = $("h2")
    .toArray()
    .map((heading) => cleanText($(heading).text()))
    .filter(Boolean)
    .filter((heading) => !/frequently asked|faq|questions/i.test(heading));
  const firstSection = sectionHeadings[0] ?? input.keyword;
  const secondSection = sectionHeadings[1] ?? sectionHeadings.at(-1) ?? input.keyword;
  const supplied = new Map(
    (input.editorialBriefs ?? []).map((brief) => [brief.role, brief]),
  );
  const fallbackVisuals: Record<ProductionBlogImageRole, string> = {
    featured: `A realistic professional setting centred on ${input.keyword}`,
    "internal-1": `A close practical scene showing ${firstSection}`,
    "internal-2": `A distinct practical setting showing ${secondSection}`,
  };
  const fallbackAltText: Record<ProductionBlogImageRole, string> = {
    featured: `Professional setting centred on ${input.keyword}`,
    "internal-1": `Close practical scene showing ${firstSection}`,
    "internal-2": `Distinct practical setting showing ${secondSection}`,
  };
  const shared = [
    `Create a polished editorial photograph for an article titled "${input.title}".`,
    `Business context: ${input.businessName}. Topic: ${input.keyword}. Locale: ${input.locale}.`,
    "Use a realistic professional composition appropriate for a trustworthy business publication.",
    "No text, letters, numbers, captions, labels, logos, brands, watermarks, UI, split screens, collages, or decorative borders.",
    "Avoid sensational imagery, exaggerated outcomes, stereotypes, and visual claims not supported by the topic.",
    "Landscape 3:2 composition with a clear focal point and natural lighting.",
  ].join(" ");
  return ALL_PRODUCTION_BLOG_IMAGE_ROLES.map((role) => {
    const brief = supplied.get(role);
    const visualDescription =
      brief?.visualDescription.trim() || fallbackVisuals[role];
    const altText = brief?.altText.trim() || fallbackAltText[role];
    return {
      role,
      altText,
      prompt: `${shared} Required visible scene: ${visualDescription}. Make this composition visually distinct from the other article images while preserving the specified subject and action.`,
    };
  });
}

async function generateOneImage(input: {
  planId: string;
  brief: { role: ProductionBlogImageRole; altText: string; prompt: string };
  recorder: ProductionPipelineUsageRecorder;
}): Promise<ProductionBlogImage> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for production blog images");
  const stage = ROLE_STAGE[input.brief.role];
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let openAiCompleted = false;
    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": `${input.recorder.context.correlationId}:${input.brief.role}`,
        },
        body: JSON.stringify({
          model: BLOG_PIPELINE_V2_IMAGE_MODEL,
          prompt: input.brief.prompt,
          n: 1,
          size: BLOG_PIPELINE_V2_IMAGE_SIZE,
          quality: BLOG_PIPELINE_V2_IMAGE_QUALITY,
        }),
      });
      const providerRequestId = response.headers.get("x-request-id")?.trim();
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(
          `OpenAI image generation failed (${response.status}): ${body.slice(0, 500)}`,
        );
        (error as any).status = response.status;
        throw error;
      }
      const payload = (await response.json()) as {
        created?: number;
        data?: Array<{ b64_json?: string; url?: string }>;
      };
      const image = payload.data?.[0];
      if (!image?.b64_json && !image?.url) {
        throw new Error("OpenAI image response contained no image");
      }
      const digest = createHash("sha256")
        .update(image.b64_json ?? image.url ?? "")
        .digest("hex");
      const providerResponseId = providerRequestId || `image-${digest}`;
      await input.recorder.recordFixedCost({
        stage,
        provider: "openai",
        model: BLOG_PIPELINE_V2_IMAGE_MODEL,
        responseId: providerResponseId,
        estimatedUsd: imageCostUsd(),
        metadata: {
          kind: "image",
          role: input.brief.role,
          imageCount: 1,
          quality: BLOG_PIPELINE_V2_IMAGE_QUALITY,
          dimensions: BLOG_PIPELINE_V2_IMAGE_SIZE,
          providerArtifactSha256: digest,
          retry: attempt - 1,
        },
      });
      openAiCompleted = true;
      const folder = `blog-pipeline-v2/${input.planId}`;
      const url = image.b64_json
        ? await uploadBase64Image(
            `data:image/png;base64,${image.b64_json}`,
            folder,
          )
        : await (async () => {
            const remote = await fetchPublicResource(image.url!, {
              maxBytes: 25 * 1024 * 1024,
              allowedContentTypes: ["image/"],
            });
            return uploadImageBuffer(remote.buffer, remote.contentType, folder);
          })();
      return {
        role: input.brief.role,
        url,
        altText: input.brief.altText.slice(0, 160),
        prompt: input.brief.prompt,
        model: BLOG_PIPELINE_V2_IMAGE_MODEL,
        quality: BLOG_PIPELINE_V2_IMAGE_QUALITY,
        size: BLOG_PIPELINE_V2_IMAGE_SIZE,
        providerResponseId,
      };
    } catch (error) {
      lastError = error;
      await input.recorder.recordFailure({
        stage,
        provider: openAiCompleted ? "bunny" : "openai",
        model: openAiCompleted ? "bunny-upload" : BLOG_PIPELINE_V2_IMAGE_MODEL,
        attempt,
        error,
      });
      const status = Number((error as any)?.status ?? 0);
      if (attempt === 2 || (status >= 400 && status < 500 && status !== 429)) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function generateProductionBlogImages(input: {
  planId: string;
  title: string;
  keyword: string;
  businessName: string;
  locale: string;
  content: string;
  editorialBriefs?: ProductionBlogEditorialImageBrief[];
  recorder: ProductionPipelineUsageRecorder;
  existing?: ProductionBlogImage[];
  onImage?: (image: ProductionBlogImage) => Promise<void>;
  durableStep?: ProductionDurableStepRunner;
  featuredImageOnly?: boolean;
}): Promise<ProductionBlogImage[]> {
  const requiredRoles = getProductionBlogImageRoles(input.featuredImageOnly);
  const requiredRoleSet = new Set(requiredRoles);
  const existing = new Map((input.existing ?? []).map((item) => [item.role, item]));
  const images: ProductionBlogImage[] = [];
  for (const brief of buildProductionBlogImageBriefs(input).filter((item) =>
    requiredRoleSet.has(item.role),
  )) {
    const checkpoint = existing.get(brief.role);
    const image = checkpoint?.url
      ? {
          ...checkpoint,
          altText: brief.altText.slice(0, 160),
          prompt: checkpoint.prompt || brief.prompt,
        }
      : await runProductionDurableStep(
          input.durableStep,
          `production-v2-image-${brief.role}`,
          async () => {
            const generated = await generateOneImage({
              planId: input.planId,
              brief,
              recorder: input.recorder,
            });
            await input.onImage?.(generated);
            return generated;
          },
        );
    images.push(image);
  }
  if (
    images.length !== requiredRoles.length ||
    new Set(images.map((image) => image.url)).size !== requiredRoles.length
  ) {
    throw new Error(
      input.featuredImageOnly
        ? "Featured-image-only blog generation requires one unique image"
        : `Production blog pipeline requires ${BLOG_PIPELINE_V2_IMAGE_COUNT} unique images`,
    );
  }
  return images;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function insertProductionInternalImages(
  html: string,
  images: ProductionBlogImage[],
): string {
  const internal = images.filter((image) => image.role !== "featured");
  if (internal.length !== 2) {
    throw new Error("Exactly two internal images are required");
  }
  const $ = load(html, null, false);
  const headings = $("h2")
    .toArray()
    .filter((heading) => !/frequently asked|faq|questions/i.test($(heading).text()));
  const targets = [headings[0], headings[Math.min(2, headings.length - 1)]];
  if (targets.some((target) => !target)) {
    throw new Error("Article needs at least one eligible H2 for internal images");
  }
  internal.forEach((image, index) => {
    const figure = [
      `<figure class="blog-content-image" data-image-role="${image.role}">`,
      `<img src="${escapeAttribute(image.url)}" alt="${escapeAttribute(image.altText)}" width="1536" height="1024" loading="lazy" decoding="async" />`,
      "</figure>",
    ].join("");
    $(targets[index]!).after(figure);
  });
  return $.html().trim();
}
