import { mkdir } from "node:fs/promises";
import path from "node:path";

import { generateWebsiteCampaignImage } from "../services/social-creative/openai-image-provider";
import type { SocialCreativeBrandContext } from "../services/social-creative/types";
import { prepareWebsiteCampaign } from "../services/social-creative/website-campaign";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

if (!process.env.OPENAI_API_KEY?.trim()) {
  throw new Error("OPENAI_API_KEY is required for the website campaign canary");
}

const context: SocialCreativeBrandContext = {
  userId: "local-canary-user",
  businessId: "local-canary-business",
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

const topic =
  process.env.SOCIAL_CREATIVE_CANARY_TOPIC?.trim() ||
  "Turn verified business information into one focused social campaign";
const runToken = `website-campaign-canary-${Date.now()}`;
const outputDirectory = path.resolve(process.argv[2] || `.tmp/${runToken}`);
await mkdir(outputDirectory, { recursive: true });

const campaign = await prepareWebsiteCampaign({
  context,
  socialTopic: topic,
  platform: "instagram",
  validatePublicUrl: async (url) => new URL(url),
});

console.log(
  `[website-campaign] GPT Image 2 ${campaign.platform} size=${campaign.format.sourceSize}`,
);
const generated = await generateWebsiteCampaignImage({
  prompt: campaign.prompt,
  targetSize: campaign.format.sourceSize,
  idempotencyKey: runToken,
});
const extension =
  generated.returned?.outputFormat === "jpeg"
    ? "jpg"
    : generated.returned?.outputFormat || "png";
const imageFile = `website-campaign.${extension}`;
await Bun.write(path.join(outputDirectory, imageFile), generated.buffer);

const manifest = {
  generatedAt: new Date().toISOString(),
  safety: {
    localOnly: true,
    databaseWrites: false,
    cloudinaryUploads: false,
    publishing: false,
  },
  engine: "website-campaign",
  providerOutputUnchanged: true,
  backendInput: {
    businessId: context.businessId,
    topic,
    websiteUrl: context.websiteUrl,
    business: campaign.business,
    brand: campaign.brand,
  },
  providerRequest: {
    model: generated.model,
    prompt: campaign.prompt,
    size: campaign.format.sourceSize,
    targetSize: campaign.format.sourceSize,
  },
  providerResponse: {
    requestId: generated.providerRequestId,
    sha256: generated.sha256,
    bytes: generated.buffer.length,
    quality: generated.quality,
    returned: generated.returned,
    usage: generated.usage,
    actualUsd: generated.actualUsd,
    estimatedUsd: generated.estimatedUsd,
    pricingVersion: generated.pricingVersion,
  },
  onboardingPublication: {
    masterPlatform: "instagram",
    sharedImageFor: ["instagram", "facebook", "linkedin", "x"],
    imageFile,
  },
};
await Bun.write(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const cards = ["instagram", "facebook", "linkedin", "x"]
  .map(
    (platform) => `<article><header><strong>${platform}</strong><span>same provider master · 1024×1536</span></header><img src="./${escapeHtml(imageFile)}" alt="${platform} website campaign preview"><p>The production onboarding caller reuses this exact image URL for ${platform}.</p></article>`,
  )
  .join("");
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Template-free website campaign canary</title><style>body{margin:0;background:#f2effa;color:#211b31;font:16px/1.5 system-ui,sans-serif}.wrap{width:min(1300px,calc(100% - 32px));margin:40px auto 80px}h1{font-size:clamp(36px,6vw,72px);line-height:.95;letter-spacing:-.05em;max-width:900px}.lead{max-width:850px;font-size:18px;color:#615873}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;margin-top:32px}article{background:white;border:1px solid #ddd5ed;border-radius:18px;overflow:hidden;box-shadow:0 18px 45px #28155012}header{display:flex;justify-content:space-between;gap:10px;padding:14px;font-size:12px;text-transform:uppercase}header span{color:#786e88;text-align:right}img{display:block;width:100%;height:auto}article p{padding:0 14px 14px;color:#615873}.prompt{margin-top:28px;background:#24164d;color:#f7f2ff;padding:22px;border-radius:18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.grid{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>One template-free GPT Image result.</h1><p class="lead">This is the exact provider-composed image returned by <code>gpt-image-2-2026-04-21</code>. No layout family, compositor, typography overlay, reference image, crop, resize, or re-encode was applied. The four cards intentionally show how onboarding shares one Instagram master URL.</p><p><a href="./manifest.json">Open full backend input, exact prompt, request, response metadata, usage, and checksum</a></p><section class="grid">${cards}</section><details class="prompt"><summary>Exact imported websiteCampaign prompt</summary><pre>${escapeHtml(campaign.prompt)}</pre></details></main></body></html>`;
await Bun.write(path.join(outputDirectory, "index.html"), html);

console.log(
  JSON.stringify(
    {
      success: true,
      outputDirectory,
      preview: path.join(outputDirectory, "index.html"),
      image: path.join(outputDirectory, imageFile),
      manifest: path.join(outputDirectory, "manifest.json"),
      providerRequestId: generated.providerRequestId,
      providerSha256: generated.sha256,
      providerOutputUnchanged: true,
      costUsd: generated.actualUsd ?? generated.estimatedUsd,
    },
    null,
    2,
  ),
);
