import { DRActionStatus, DRActionType, DROutreachStatus } from "@prisma/client";
import { prisma } from "../config/db.config";
import { createGPT4oMiniModel } from "../config/llm.config";
import { fetchDomainRankFromDataForSEO } from "../utils/dataforseo-backlinks.utils";
import { createOutreachUnsubscribeToken } from "../utils/outreach-unsubscribe-token";
import {
  HIGH_AUTHORITY_GUEST_POSTING_TEMPLATE,
  HIGH_AUTHORITY_MAX_SPAM_SCORE,
  HIGH_AUTHORITY_MIN_DA,
  evaluateGuestPostPublisher,
} from "./guest-posting-quality.service";

const MAX_PITCHES_PER_WEEK = 5;
const COOLDOWN_DAYS = 90;

const CAN_SPAM_FOOTER = `\n\n---\nThis email was sent on behalf of a business using Uplift AI (https://upliftai.co).\nPhysical address: Uplift AI, 548 Market St #36879, San Francisco, CA 94104\nTo stop receiving outreach from this sender, reply with "unsubscribe" or click: {unsubscribe_url}`;

function buildEmailBody(body: string, campaignId: string): string {
  const unsubscribeToken = createOutreachUnsubscribeToken(campaignId);
  const apiBaseUrl =
    process.env.BACKEND_URL?.replace(/\/$/, "") || "https://api.upliftai.co";
  const unsubUrl = `${apiBaseUrl}/api/v1/dr-dashboard/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  return body + CAN_SPAM_FOOTER.replace("{unsubscribe_url}", unsubUrl);
}

/**
 * Discover high-DA publishers for a business and create outreach campaigns.
 */
export async function discoverAndQueuePublishers(businessId: string): Promise<{
  discovered: number;
  queued: number;
}> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      ExternalBacklinkSummary: true,
    },
  });

  if (!business) return { discovered: 0, queued: 0 };

  const excludedDomains = business.excludedOutreachDomains || [];
  const currentDA = business.ExternalBacklinkSummary?.averageDomainAuthority ?? 0;
  const minPublisherDA = Math.max(currentDA, HIGH_AUTHORITY_MIN_DA); // Only pitch stronger, high-authority sites

  // Find existing guest post publishers that haven't been pitched recently
  // GuestPostPublisher is per-user, so look up the userId from the business
  const publishers = await prisma.guestPostPublisher.findMany({
    where: {
      userId: business.userId,
      domainAuthority: { gte: Math.round(minPublisherDA) },
      isActive: true,
    },
    orderBy: { domainAuthority: "desc" },
    take: 20,
  });

  let queued = 0;

  for (const publisher of publishers) {
    // Skip blacklisted domains
    if (excludedDomains.some((d: string) => publisher.domain.includes(d))) continue;

    const quality = evaluateGuestPostPublisher(publisher, {
      campaignTemplate: HIGH_AUTHORITY_GUEST_POSTING_TEMPLATE,
      targetNiche: business.businessType,
      minDomainAuthority: Math.round(minPublisherDA),
      maxPublisherSpamScore: HIGH_AUTHORITY_MAX_SPAM_SCORE,
      requireNicheMatch: true,
      requireVerifiedPublishers: true,
      autoSendPitch: true,
    });

    if (!quality.canAutoSend) {
      await prisma.guestPostPublisher.update({
        where: { id: publisher.id },
        data: {
          qualityScore: quality.score,
          qualityGateStatus: quality.status,
          qualityGateReasons: [...quality.reasons, ...quality.warnings],
          complianceNotes: quality.complianceNotes,
        },
      });
      continue;
    }

    // Check if already has an active campaign or is in cooldown
    const existingCampaign = await prisma.dROutreachCampaign.findFirst({
      where: {
        businessId,
        publisherDomain: publisher.domain,
        OR: [
          { status: { in: [DROutreachStatus.DRAFTED, DROutreachStatus.SENT, DROutreachStatus.OPENED] } },
          { cooldownUntil: { gte: new Date() } },
        ],
      },
    });

    if (existingCampaign) continue;

    // Check weekly rate limit
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const sentThisWeek = await prisma.dROutreachCampaign.count({
      where: {
        businessId,
        sentAt: { gte: weekAgo },
      },
    });

    if (sentThisWeek >= MAX_PITCHES_PER_WEEK) break;

    // Create outreach campaign
    await prisma.dROutreachCampaign.create({
      data: {
        businessId,
        publisherDomain: publisher.domain,
        publisherEmail: publisher.contactEmail,
        publisherDA: publisher.domainAuthority,
        status: DROutreachStatus.DRAFTED,
        inboundReplyAddress: `reply-${businessId.substring(0, 8)}@inbound.upliftai.co`,
        cooldownUntil: new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    queued++;
  }

  return { discovered: publishers.length, queued };
}

/**
 * Generate a personalized pitch for a queued outreach campaign.
 */
export async function generatePitchForCampaign(campaignId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const campaign = await prisma.dROutreachCampaign.findUnique({
    where: { id: campaignId },
    include: {
      business: true,
    },
  });

  if (!campaign || campaign.status !== DROutreachStatus.DRAFTED) {
    return { success: false, error: "Campaign not found or not in DRAFTED status" };
  }

  const llm = createGPT4oMiniModel(0.4);

  const prompt = `Write a professional guest post pitch email.

FROM: ${campaign.business.businessName || "a business owner"}
TO: Editor at ${campaign.publisherDomain}
ABOUT: ${campaign.business.businessDescription || campaign.business.businessName || "their industry"}

Requirements:
- Keep it under 150 words
- Propose a specific, valuable topic relevant to their audience
- Include a brief 1-sentence bio/credibility statement
- Be professional but personable, not templated
- Include a clear value proposition for their readers
- Do NOT use overly salesy language

Return a JSON object with these fields:
{
  "subject": "Email subject line",
  "body": "Full email body (plain text)",
  "proposedTopic": "The specific topic proposed"
}

Return ONLY the JSON, nothing else.`;

  try {
    const response = await llm.invoke(prompt);
    const content = typeof response.content === "string" ? response.content : String(response.content);

    // Parse JSON from response (handle potential markdown fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("LLM did not return valid JSON");

    const pitch = JSON.parse(jsonMatch[0]);

    await prisma.dROutreachCampaign.update({
      where: { id: campaignId },
      data: {
        pitchSubject: pitch.subject,
        pitchContent: pitch.body,
        proposedTopic: pitch.proposedTopic,
      },
    });

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Send the pitch email for a campaign via Resend.
 */
export async function sendOutreachEmail(campaignId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const campaign = await prisma.dROutreachCampaign.findUnique({
    where: { id: campaignId },
    include: { business: true },
  });

  if (!campaign || !campaign.pitchContent || !campaign.publisherEmail) {
    return { success: false, error: "Campaign not ready to send (missing content or email)" };
  }

  const publisher = await prisma.guestPostPublisher.findFirst({
    where: {
      userId: campaign.business.userId,
      domain: campaign.publisherDomain,
      isActive: true,
    },
  });

  if (!publisher) {
    return {
      success: false,
      error: "Publisher quality record is required before outreach",
    };
  }

  const quality = evaluateGuestPostPublisher(publisher, {
    campaignTemplate: HIGH_AUTHORITY_GUEST_POSTING_TEMPLATE,
    targetNiche: campaign.business.businessType,
    minDomainAuthority: HIGH_AUTHORITY_MIN_DA,
    maxPublisherSpamScore: HIGH_AUTHORITY_MAX_SPAM_SCORE,
    requireNicheMatch: true,
    requireVerifiedPublishers: true,
    autoSendPitch: true,
  });

  if (!quality.canAutoSend) {
    return {
      success: false,
      error:
        quality.complianceNotes ||
        "Publisher is not approved for automated outreach",
    };
  }

  // Check rate limit one more time before sending
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const sentThisWeek = await prisma.dROutreachCampaign.count({
    where: {
      businessId: campaign.businessId,
      sentAt: { gte: weekAgo },
    },
  });

  if (sentThisWeek >= MAX_PITCHES_PER_WEEK) {
    return { success: false, error: "Weekly rate limit reached" };
  }

  try {
    // Import Resend dynamically to avoid issues if not configured
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const fromName = campaign.business.businessName || "Uplift AI";
    const fromEmail = process.env.OUTREACH_FROM_EMAIL || "outreach@upliftai.co";

    const emailBody = buildEmailBody(campaign.pitchContent, campaignId);

    const result = await resend.emails.send({
      from: `${fromName} via Uplift AI <${fromEmail}>`,
      to: campaign.publisherEmail,
      replyTo: campaign.inboundReplyAddress || fromEmail,
      subject: campaign.pitchSubject || "Guest Post Opportunity",
      text: emailBody,
    });

    // Create email tracking record
    await prisma.dROutreachEmail.create({
      data: {
        campaignId,
        emailType: "PITCH",
        recipientEmail: campaign.publisherEmail,
        subject: campaign.pitchSubject || "Guest Post Opportunity",
        body: emailBody,
        resendEmailId: result.data?.id,
        sentAt: new Date(),
      },
    });

    // Update campaign status
    await prisma.dROutreachCampaign.update({
      where: { id: campaignId },
      data: {
        status: DROutreachStatus.SENT,
        sentAt: new Date(),
      },
    });

    // Log the action
    await prisma.dRActionLog.create({
      data: {
        businessId: campaign.businessId,
        actionType: DRActionType.GUEST_POST_PITCH,
        status: DRActionStatus.COMPLETED,
        completedAt: new Date(),
        details: {
          campaignId,
          publisherDomain: campaign.publisherDomain,
          publisherDA: campaign.publisherDA,
        },
      },
    });

    return { success: true };
  } catch (error: any) {
    await prisma.dROutreachCampaign.update({
      where: { id: campaignId },
      data: { status: DROutreachStatus.DRAFTED }, // Reset to allow retry
    });

    return { success: false, error: error.message };
  }
}

/**
 * Process an inbound reply from a publisher (called by webhook handler).
 * Parses intent via GPT and updates campaign status.
 */
export async function processInboundReply(params: {
  fromEmail: string;
  toAddress: string;
  subject: string;
  body: string;
}): Promise<{ success: boolean; campaignId?: string; intent?: string; error?: string }> {
  const replyMatch = params.toAddress.match(/^reply-([a-f0-9]+)@/i);
  if (!replyMatch) {
    return { success: false, error: "Could not parse business ID from reply address" };
  }
  const businessIdPrefix = replyMatch[1];

  const campaign = await prisma.dROutreachCampaign.findFirst({
    where: {
      publisherEmail: params.fromEmail,
      businessId: { startsWith: businessIdPrefix },
      status: { in: [DROutreachStatus.SENT, DROutreachStatus.OPENED] },
    },
    include: { business: true },
  });

  if (!campaign) {
    return { success: false, error: "No matching campaign found for this reply" };
  }

  const llm = createGPT4oMiniModel(0.2);
  const intentPrompt = `Classify this email reply to a guest post pitch. The original pitch proposed writing a guest post for their website.

Reply subject: ${params.subject}
Reply body: ${params.body.substring(0, 2000)}

Classify as ONE of:
- "accepted" - they want the guest post
- "rejected" - they declined
- "question" - they're asking a question or requesting clarification
- "unsubscribe" - they want to stop receiving emails

Return ONLY the classification word, nothing else.`;

  try {
    const response = await llm.invoke(intentPrompt);
    const intent = (typeof response.content === "string" ? response.content : String(response.content))
      .trim()
      .toLowerCase();

    let newStatus: DROutreachStatus;
    if (intent === "accepted") {
      newStatus = DROutreachStatus.ACCEPTED;
    } else if (intent === "rejected" || intent === "unsubscribe") {
      newStatus = DROutreachStatus.REJECTED;
    } else {
      newStatus = DROutreachStatus.NEEDS_REVIEW;
    }

    await prisma.dROutreachCampaign.update({
      where: { id: campaign.id },
      data: {
        status: newStatus,
        respondedAt: new Date(),
        responseContent: params.body.substring(0, 5000),
      },
    });

    return { success: true, campaignId: campaign.id, intent };
  } catch (error: any) {
    await prisma.dROutreachCampaign.update({
      where: { id: campaign.id },
      data: {
        status: DROutreachStatus.NEEDS_REVIEW,
        respondedAt: new Date(),
        responseContent: params.body.substring(0, 5000),
      },
    });
    return { success: false, campaignId: campaign.id, error: error.message };
  }
}

/**
 * Generate a guest post draft after a pitch is accepted.
 */
export async function generateGuestContent(campaignId: string): Promise<{
  success: boolean;
  blogId?: string;
  error?: string;
}> {
  const campaign = await prisma.dROutreachCampaign.findUnique({
    where: { id: campaignId },
    include: { business: true },
  });

  if (!campaign || campaign.status !== DROutreachStatus.ACCEPTED) {
    return { success: false, error: "Campaign not in ACCEPTED status" };
  }

  if (!campaign.proposedTopic) {
    return { success: false, error: "No proposed topic to write about" };
  }

  const llm = createGPT4oMiniModel(0.5);
  const prompt = `Write a professional guest blog post.

Topic: ${campaign.proposedTopic}
For publication on: ${campaign.publisherDomain}
Written by: ${campaign.business.businessName || "the author"}
About the author's business: ${campaign.business.businessDescription || "N/A"}

Requirements:
- 800-1200 words
- Professional and informative tone
- Include 1-2 natural mentions of the author's business (not promotional)
- Include a brief author bio at the end (2-3 sentences)
- Return the content in HTML format
- Do NOT include the title in the body content

Return a JSON object:
{
  "title": "The blog post title",
  "content": "Full HTML content of the blog post",
  "excerpt": "A 1-2 sentence summary"
}

Return ONLY the JSON.`;

  try {
    const response = await llm.invoke(prompt);
    const text = typeof response.content === "string" ? response.content : String(response.content);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("LLM did not return valid JSON");

    const post = JSON.parse(jsonMatch[0]);

    const meta = await prisma.meta.create({
      data: {
        seo_title: post.title,
        seo_description: post.excerpt || "",
        focus_keyword: campaign.proposedTopic,
      },
    });

    const customField = await prisma.customField.create({
      data: {
        reading_time: "5 min read",
        rating: 0,
      },
    });

    const blog = await prisma.blog.create({
      data: {
        title: post.title,
        content: post.content,
        excerpt: post.excerpt || "",
        slug: post.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        status: "DRAFT",
        featured_media: "",
        blogPublishTime: "09:00",
        blogPublishDate: new Date().toISOString().split("T")[0] ?? "",
        categories: ["Guest Post"],
        tags: [campaign.publisherDomain],
        userId: campaign.business.userId,
        businessId: campaign.businessId,
        metaId: meta.id,
        customFieldId: customField.id,
      },
    });

    await prisma.dROutreachCampaign.update({
      where: { id: campaignId },
      data: { guestPostBlogId: blog.id },
    });

    await prisma.dRActionLog.create({
      data: {
        businessId: campaign.businessId,
        actionType: DRActionType.GUEST_POST_PITCH,
        status: DRActionStatus.COMPLETED,
        completedAt: new Date(),
        details: {
          campaignId,
          action: "guest_content_generated",
          blogId: blog.id,
          publisherDomain: campaign.publisherDomain,
        },
      },
    });

    return { success: true, blogId: blog.id };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
