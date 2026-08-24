import { mkdir } from "node:fs/promises";
import path from "node:path";

import { generateWebsiteCampaignImage } from "../services/social-creative/openai-image-provider";
import type {
  SocialCreativeBrandContext,
  SocialPlatform,
} from "../services/social-creative/types";
import { prepareWebsiteCampaign } from "../services/social-creative/website-campaign";

const PLATFORMS = ["instagram", "facebook", "linkedin", "x"] as const satisfies readonly SocialPlatform[];

const context: SocialCreativeBrandContext = {
  userId: "local-pack-canary-user",
  businessId: "local-pack-canary-business",
  businessName: "Uplift AI",
  businessType: "AI-powered SEO and local visibility platform",
  businessDescription:
    "A platform that helps local businesses turn verified website and business information into practical SEO content and visibility workflows.",
  websiteUrl: "https://upliftai.co/",
  phone: null,
  city: "Toronto",
  state: "Ontario",
  country: "Canada",
  language: "en",
  locale: "en-CA",
  tone: "clear, calm, and professional",
  targetAudience:
    "Local business owners who want consistent, grounded marketing without managing disconnected tools",
  services: [
    "SEO content planning",
    "Local visibility workflows",
    "Website-informed social campaign generation",
  ],
  primaryColors: ["#6D4AFF", "#24164D"],
  secondaryColors: ["#F4F0FF", "#FFFFFF"],
  fontFamily: "Montserrat",
  logoUrl: "https://upliftai.co/logo.png",
  referenceImageUrls: [],
  recentCreativeHistory: [],
  tagline: "Practical AI for business visibility",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function trimSentence(value: string): string {
  return value.trim().replace(/[.!?]+$/, "");
}

function truncateAtWord(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  const candidate = value.slice(0, Math.max(0, maximumLength - 1)).trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");
  const boundary = lastSpace > maximumLength * 0.65
    ? candidate.slice(0, lastSpace)
    : candidate;
  return `${boundary.replace(/[.,;:!?-]+$/, "")}…`;
}

type VerifiedCanaryTopic = {
  title: string;
  keyword: string;
  socialHook: string;
  caption: string;
  website: string;
};

function buildVerifiedCanaryTopic(
  socialTopic: string,
  facts: SocialCreativeBrandContext,
): VerifiedCanaryTopic {
  const title = trimSentence(socialTopic);
  const description = trimSentence(facts.businessDescription);
  const audience = trimSentence(facts.targetAudience || "local business owners");
  const services = facts.services.join(" · ");
  const website = new URL(facts.websiteUrl).toString();

  return {
    title,
    keyword: title,
    socialHook: `${title}.`,
    caption: [
      `${facts.businessName} is an ${facts.businessType.toLowerCase()}.`,
      `${description}.`,
      `It is built for ${audience.toLowerCase()} and includes ${services}.`,
      `Learn more: ${website}`,
    ].join(" "),
    website,
  };
}

function buildPlatformPostCaption(
  platform: SocialPlatform,
  topic: VerifiedCanaryTopic,
): string {
  switch (platform) {
    case "instagram":
      return topic.caption;
    case "facebook":
      return topic.caption;
    case "linkedin": {
      const includesHook = topic.caption
        .toLocaleLowerCase()
        .includes(topic.socialHook.toLocaleLowerCase());
      const copy = includesHook
        ? topic.caption
        : `${topic.socialHook}\n\n${topic.caption}`;
      return copy;
    }
    case "x": {
      const hook = truncateAtWord(topic.socialHook, 70);
      const punch = `Learn more: ${topic.website}`;
      const proof = truncateAtWord(
        topic.caption.replace(/\s*Learn more:\s*https?:\/\/\S+\s*$/i, ""),
        280 - hook.length - punch.length - 4,
      );
      return `${hook}\n\n${proof}\n\n${punch}`;
    }
  }
}

function imageExtension(outputFormat: string | undefined, mimeType: string | undefined): string {
  const normalized = String(outputFormat || mimeType?.split("/")[1] || "png")
    .trim()
    .toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") return "jpg";
  if (normalized === "webp") return "webp";
  return "png";
}

function formatUsd(value: number | null): string {
  return value === null ? "unavailable" : `$${value.toFixed(6)}`;
}

function platformLabel(platform: SocialPlatform): string {
  if (platform === "x") return "X";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function renderPostCard(input: {
  platform: SocialPlatform;
  caption: string;
  imageFile: string;
  returnedWidth: number | null;
  returnedHeight: number | null;
  requestId: string;
  sha256: string;
  costUsd: number;
}): string {
  const platform = platformLabel(input.platform);
  const dimensions = input.returnedWidth && input.returnedHeight
    ? `${input.returnedWidth}\u00d7${input.returnedHeight}`
    : "provider dimensions unavailable";
  const actions = input.platform === "x"
    ? ["Reply", "Repost", "Like", "Share"]
    : input.platform === "linkedin"
      ? ["Like", "Comment", "Repost", "Send"]
      : input.platform === "facebook"
        ? ["Like", "Comment", "Share"]
        : ["Like", "Comment", "Send", "Save"];

  return `<article class="post post-${escapeHtml(input.platform)}">
    <header class="post-header">
      <div class="avatar" aria-hidden="true">UA</div>
      <div class="identity">
        <strong>${escapeHtml(context.businessName)}</strong>
        <span>@upliftai · local canary</span>
      </div>
      <span class="platform">${escapeHtml(platform)}</span>
    </header>
    <p class="caption">${escapeHtml(input.caption)}</p>
    <img src="./${escapeHtml(input.imageFile)}" alt="${escapeHtml(platform)} provider-native website campaign canary">
    <div class="post-meta">
      <span>${escapeHtml(dimensions)} · exact provider bytes</span>
      <span>${escapeHtml(formatUsd(input.costUsd))}</span>
    </div>
    <footer class="actions">${actions.map((action) => `<span>${escapeHtml(action)}</span>`).join("")}</footer>
    <details class="receipt">
      <summary>Provider receipt</summary>
      <dl>
        <dt>Request</dt><dd>${escapeHtml(input.requestId)}</dd>
        <dt>SHA-256</dt><dd>${escapeHtml(input.sha256)}</dd>
      </dl>
    </details>
  </article>`;
}

if (!process.env.OPENAI_API_KEY?.trim()) {
  throw new Error("OPENAI_API_KEY is required for the four-platform social creative pack canary");
}

const socialTopic =
  process.env.SOCIAL_CREATIVE_CANARY_TOPIC?.trim() ||
  "Turn verified business information into one focused social campaign";
const verifiedTopic = buildVerifiedCanaryTopic(socialTopic, context);
const runId = `website-campaign-pack-canary-${Date.now()}`;
const outputDirectory = path.resolve(
  process.argv[2] ||
    process.env.SOCIAL_CREATIVE_CANARY_OUTPUT_DIR ||
    `.tmp/${runId}`,
);
await mkdir(outputDirectory, { recursive: true });

console.log(`[website-campaign-pack] Local-only canary output: ${outputDirectory}`);
console.log(
  "[website-campaign-pack] Starting four independent GPT Image 2 calls; no database, Cloudinary, or publishing clients are imported.",
);

const generatedAt = new Date().toISOString();
const artifacts: Array<{
  platform: SocialPlatform;
  caption: string;
  imageFile: string;
  prompt: string;
  providerRequest: {
    idempotencyKey: string;
    model: string;
    size: string;
    targetSize: string;
  };
  providerResponse: {
    requestId: string;
    sha256: string;
    bytes: number;
    quality: string | null;
    returned: unknown;
    usage: unknown;
    actualUsd: number | null;
    estimatedUsd: number;
    chargedOrEstimatedUsd: number;
    pricingVersion: string;
  };
}> = [];

for (const platform of PLATFORMS) {
  const campaign = await prepareWebsiteCampaign({
    context,
    socialTopic,
    platform,
    // The canary context is intentionally fixed and verified in this file.
    // Avoid an unrelated DNS/network lookup; the only external call is OpenAI.
    validatePublicUrl: async (url) => new URL(url),
  });
  const idempotencyKey = `${runId}:${platform}`;
  console.log(
    `[website-campaign-pack] Generating ${platform} size=${campaign.format.sourceSize}`,
  );
  const generated = await generateWebsiteCampaignImage({
    prompt: campaign.prompt,
    targetSize: campaign.format.sourceSize,
    idempotencyKey,
  });
  const extension = imageExtension(
    generated.returned?.outputFormat,
    generated.returned?.mimeType,
  );
  const imageFile = `${platform}.${extension}`;
  const imagePath = path.join(outputDirectory, imageFile);
  await Bun.write(imagePath, generated.buffer);
  const chargedOrEstimatedUsd = generated.actualUsd ?? generated.estimatedUsd;
  const caption = buildPlatformPostCaption(platform, verifiedTopic);

  artifacts.push({
    platform,
    caption,
    imageFile,
    prompt: campaign.prompt,
    providerRequest: {
      idempotencyKey,
      model: generated.model,
      size: campaign.format.sourceSize,
      targetSize: campaign.format.sourceSize,
    },
    providerResponse: {
      requestId: generated.providerRequestId,
      sha256: generated.sha256,
      bytes: generated.buffer.length,
      quality: generated.quality,
      returned: generated.returned ?? null,
      usage: generated.usage,
      actualUsd: generated.actualUsd,
      estimatedUsd: generated.estimatedUsd,
      chargedOrEstimatedUsd,
      pricingVersion: generated.pricingVersion,
    },
  });

  console.log(
    `[website-campaign-pack] Wrote ${imagePath} · ${formatUsd(chargedOrEstimatedUsd)} · sha256=${generated.sha256}`,
  );
}

const totalActualUsd = artifacts.every(
  (artifact) => artifact.providerResponse.actualUsd !== null,
)
  ? artifacts.reduce(
      (sum, artifact) => sum + (artifact.providerResponse.actualUsd ?? 0),
      0,
    )
  : null;
const totalChargedOrEstimatedUsd = artifacts.reduce(
  (sum, artifact) => sum + artifact.providerResponse.chargedOrEstimatedUsd,
  0,
);

const manifest = {
  generatedAt,
  runId,
  safety: {
    localOnly: true,
    databaseReads: false,
    databaseWrites: false,
    cloudinaryUploads: false,
    publishing: false,
    providerCalls: artifacts.length,
    expectedProviderCalls: PLATFORMS.length,
  },
  engine: "website-campaign-direct",
  providerOutputUnchanged: true,
  captionGeneration: {
    modelCalls: 0,
    strategy: "deterministic-studio-platform-variants-from-verified-canary-topic",
    contract: {
      instagram: "topic.caption without hashtags",
      facebook: "topic.caption without hashtags",
      linkedin:
        "socialHook + blank line + topic.caption unless caption already includes hook; no hashtags",
      x: "three copy lines separated by blank lines, no hashtags, capped at 280 characters",
    },
    verifiedTopic,
  },
  verifiedCanaryInput: {
    businessId: context.businessId,
    websiteUrl: context.websiteUrl,
    socialTopic,
    businessName: context.businessName,
    businessType: context.businessType,
    businessDescription: context.businessDescription,
    targetAudience: context.targetAudience,
    services: context.services,
    brand: {
      primaryColors: context.primaryColors,
      secondaryColors: context.secondaryColors,
      fontFamily: context.fontFamily,
      logoUrl: context.logoUrl,
      tagline: context.tagline,
    },
  },
  cost: {
    currency: "USD",
    totalActualUsd,
    totalChargedOrEstimatedUsd,
  },
  artifacts,
};
const manifestPath = path.join(outputDirectory, "manifest.json");
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const cards = artifacts
  .map((artifact) =>
    renderPostCard({
      platform: artifact.platform,
      caption: artifact.caption,
      imageFile: artifact.imageFile,
      returnedWidth:
        (artifact.providerResponse.returned as { width?: number } | null)?.width ?? null,
      returnedHeight:
        (artifact.providerResponse.returned as { height?: number } | null)?.height ?? null,
      requestId: artifact.providerResponse.requestId,
      sha256: artifact.providerResponse.sha256,
      costUsd: artifact.providerResponse.chargedOrEstimatedUsd,
    }),
  )
  .join("\n");
const previewPath = path.join(outputDirectory, "index.html");
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Four-platform provider-native social creative canary</title>
  <style>
    :root{color-scheme:light;--ink:#1f172e;--muted:#71677f;--line:#e1d9ee;--panel:#fff;--accent:#6d4aff;--deep:#24164d}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#f7f3ff,#eee9f8);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
    .wrap{width:min(1440px,calc(100% - 32px));margin:42px auto 80px}.eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
    h1{font-size:clamp(38px,6vw,78px);line-height:.94;letter-spacing:-.055em;margin:.2em 0;max-width:1050px}.lead{max-width:900px;color:var(--muted);font-size:18px}
    .summary{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 34px}.summary span,.summary a{background:#ffffffb8;border:1px solid var(--line);border-radius:999px;color:var(--ink);padding:8px 13px;text-decoration:none}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.post{align-self:start;background:var(--panel);border:1px solid var(--line);border-radius:22px;box-shadow:0 18px 55px #28155013;overflow:hidden}
    .post-header{display:flex;align-items:center;gap:11px;padding:16px}.avatar{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:linear-gradient(145deg,var(--accent),var(--deep));color:#fff;font-weight:800}
    .identity{display:flex;flex:1;flex-direction:column;min-width:0}.identity span,.post-meta{color:var(--muted);font-size:12px}.platform{border:1px solid var(--line);border-radius:999px;font-size:12px;font-weight:800;padding:5px 9px}
    .caption{margin:0;padding:2px 16px 18px;white-space:pre-line;overflow-wrap:anywhere}.post img{display:block;width:100%;height:auto;background:#eee}.post-meta{display:flex;justify-content:space-between;gap:10px;padding:12px 16px}
    .actions{display:flex;justify-content:space-around;border-top:1px solid var(--line);padding:12px 8px;color:#51475e;font-size:13px;font-weight:700}.receipt{border-top:1px solid var(--line);padding:11px 16px;color:var(--muted);font-size:12px}.receipt summary{cursor:pointer}
    dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{font-weight:800}dd{margin:0;overflow-wrap:anywhere}.footnote{margin:30px 0 0;padding:20px;border-radius:18px;background:var(--deep);color:#f8f4ff}.footnote a{color:#d9ccff}
    @media(max-width:800px){.grid{grid-template-columns:1fr}.wrap{margin-top:24px}h1{font-size:44px}}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">Local-only verification pack</div>
    <h1>Four platforms. Four direct GPT Image results.</h1>
    <p class="lead">Each card uses an independent provider-native image generated from the same verified business facts and topic. Captions are deterministic and platform-specific; they make no additional model call. Images are the exact decoded provider bytes with no template, Sharp operation, compositor, crop, resize, font render, Cloudinary upload, database write, or publishing action.</p>
    <div class="summary">
      <span>4 image calls</span>
      <span>0 caption calls</span>
      <span>${escapeHtml(formatUsd(totalChargedOrEstimatedUsd))} actual-or-estimated total</span>
      <a href="./manifest.json">Open manifest</a>
    </div>
    <section class="grid">${cards}</section>
    <p class="footnote">The manifest contains every platform's exact prompt, idempotency key, provider request ID, usage, cost, dimensions, and SHA-256 checksum. This folder is a local review artifact only; it is not connected to the application database, Cloudinary, or any publishing surface.</p>
  </main>
</body>
</html>`;
await Bun.write(previewPath, html);

console.log(
  JSON.stringify(
    {
      success: true,
      outputDirectory,
      preview: previewPath,
      manifest: manifestPath,
      images: artifacts.map((artifact) => ({
        platform: artifact.platform,
        path: path.join(outputDirectory, artifact.imageFile),
        costUsd: artifact.providerResponse.chargedOrEstimatedUsd,
        actualUsd: artifact.providerResponse.actualUsd,
      })),
      providerCalls: artifacts.length,
      captionModelCalls: 0,
      totalActualUsd,
      totalChargedOrEstimatedUsd,
      providerOutputUnchanged: true,
    },
    null,
    2,
  ),
);
