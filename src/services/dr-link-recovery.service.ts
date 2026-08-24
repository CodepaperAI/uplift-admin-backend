import { DRActionStatus, DRActionType, DRLinkRecoveryStatus } from "@prisma/client";
import axios from "axios";
import { prisma } from "../config/db.config";
import { createGPT4oMiniModel } from "../config/llm.config";

const MAX_RECLAIM_EMAILS_PER_WEEK = 3;

/**
 * Detect newly lost backlinks for a business after a sync.
 * Called after ExternalBacklinksService.syncBacklinksForBusiness().
 */
export async function detectLostLinks(businessId: string): Promise<{
  detected: number;
  recoverable: number;
}> {
  // Find backlinks that were recently marked as lost
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const newlyLostLinks = await prisma.externalBacklink.findMany({
    where: {
      businessId,
      isLost: true,
      lostAt: { gte: oneDayAgo },
    },
    orderBy: { domainAuthority: "desc" },
  });

  let recoverable = 0;

  for (const link of newlyLostLinks) {
    // Check if already tracked
    const existing = await prisma.dRLinkRecovery.findFirst({
      where: {
        businessId,
        sourceUrl: link.sourceUrl,
        targetUrl: link.targetUrl,
      },
    });

    if (existing) continue;

    await prisma.dRLinkRecovery.create({
      data: {
        businessId,
        backlinkId: link.id,
        sourceUrl: link.sourceUrl,
        sourceDomain: link.sourceDomain,
        targetUrl: link.targetUrl,
        domainAuthority: link.domainAuthority,
        lostAt: link.lostAt || new Date(),
        reclaimStatus: DRLinkRecoveryStatus.DETECTED,
      },
    });
    recoverable++;
  }

  return { detected: newlyLostLinks.length, recoverable };
}

/**
 * Analyze a lost link to determine if it's recoverable.
 */
export async function analyzeLostLink(recoveryId: string): Promise<{
  recoverable: boolean;
  reason: string;
}> {
  const recovery = await prisma.dRLinkRecovery.findUnique({
    where: { id: recoveryId },
  });

  if (!recovery) return { recoverable: false, reason: "Recovery record not found" };

  await prisma.dRLinkRecovery.update({
    where: { id: recoveryId },
    data: { reclaimStatus: DRLinkRecoveryStatus.ANALYZING },
  });

  try {
    // Check if the source page still exists
    let pageExists = false;
    let pageContent = "";
    let wasRedirected = false;
    let finalUrl = "";
    try {
      const response = await axios.get(recovery.sourceUrl, {
        timeout: 15000,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; UpliftAI/1.0; +https://upliftai.co)",
        },
        validateStatus: (status) => status < 500,
      });

      // Detect redirects by comparing the final URL with the original
      finalUrl = response.request?.res?.responseUrl || response.config?.url || "";
      if (finalUrl && finalUrl !== recovery.sourceUrl) {
        wasRedirected = true;
      }

      if (response.status === 200) {
        pageExists = true;
        pageContent = typeof response.data === "string" ? response.data : "";
      } else if (response.status === 404 || response.status === 410) {
        // Page removed
        await prisma.dRLinkRecovery.update({
          where: { id: recoveryId },
          data: {
            reclaimStatus: DRLinkRecoveryStatus.NOT_RECOVERABLE,
            reason: "page_removed",
            analyzedAt: new Date(),
          },
        });
        return { recoverable: false, reason: "page_removed" };
      }
    } catch (fetchError: any) {
      // Domain unreachable
      await prisma.dRLinkRecovery.update({
        where: { id: recoveryId },
        data: {
          reclaimStatus: DRLinkRecoveryStatus.NOT_RECOVERABLE,
          reason: "domain_expired",
          analyzedAt: new Date(),
        },
      });
      return { recoverable: false, reason: "domain_expired" };
    }

    if (pageExists) {
      // Check if the link is still in the page (maybe changed to nofollow)
      const targetUrlInPage = pageContent.includes(recovery.targetUrl);

      if (targetUrlInPage) {
        // Link still there but may have changed to nofollow
        const nofollowPattern = new RegExp(
          `<a[^>]*href=["']${recovery.targetUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*rel=["'][^"']*nofollow`,
          "i"
        );
        if (nofollowPattern.test(pageContent)) {
          await prisma.dRLinkRecovery.update({
            where: { id: recoveryId },
            data: {
              reclaimStatus: DRLinkRecoveryStatus.NOT_RECOVERABLE,
              reason: "nofollow_changed",
              analyzedAt: new Date(),
            },
          });
          return { recoverable: false, reason: "nofollow_changed" };
        }

        if (wasRedirected) {
          // Link exists on the redirected URL — DataForSEO tracked the old URL
          await prisma.dRLinkRecovery.update({
            where: { id: recoveryId },
            data: {
              reclaimStatus: DRLinkRecoveryStatus.RECOVERABLE,
              reason: "redirect_issue",
              analyzedAt: new Date(),
            },
          });
          return { recoverable: true, reason: "redirect_issue" };
        }

        // Link exists, dofollow, same URL — DataForSEO sync issue
        await prisma.dRLinkRecovery.update({
          where: { id: recoveryId },
          data: {
            reclaimStatus: DRLinkRecoveryStatus.NOT_RECOVERABLE,
            reason: "link_still_present",
            analyzedAt: new Date(),
          },
        });
        return { recoverable: false, reason: "link_still_present" };
      }

      // Page exists but link was removed — this is recoverable
      await prisma.dRLinkRecovery.update({
        where: { id: recoveryId },
        data: {
          reclaimStatus: DRLinkRecoveryStatus.RECOVERABLE,
          reason: "link_removed",
          analyzedAt: new Date(),
        },
      });
      return { recoverable: true, reason: "link_removed" };
    }

    await prisma.dRLinkRecovery.update({
      where: { id: recoveryId },
      data: {
        reclaimStatus: DRLinkRecoveryStatus.NOT_RECOVERABLE,
        reason: "unknown",
        analyzedAt: new Date(),
      },
    });
    return { recoverable: false, reason: "unknown" };
  } catch (error: any) {
    await prisma.dRLinkRecovery.update({
      where: { id: recoveryId },
      data: {
        reclaimStatus: DRLinkRecoveryStatus.NOT_RECOVERABLE,
        reason: `analysis_error: ${error.message}`,
        analyzedAt: new Date(),
      },
    });
    return { recoverable: false, reason: `error: ${error.message}` };
  }
}

/**
 * Generate and send a reclaim email for a recoverable lost link.
 */
export async function sendReclaimEmail(recoveryId: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const recovery = await prisma.dRLinkRecovery.findUnique({
    where: { id: recoveryId },
    include: { business: true },
  });

  if (!recovery || recovery.reclaimStatus !== DRLinkRecoveryStatus.RECOVERABLE) {
    return { success: false, error: "Recovery not in RECOVERABLE status" };
  }

  // Rate limit check
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const reclaimsSentThisWeek = await prisma.dRLinkRecovery.count({
    where: {
      businessId: recovery.businessId,
      reclaimStatus: DRLinkRecoveryStatus.EMAILED,
      updatedAt: { gte: weekAgo },
    },
  });

  if (reclaimsSentThisWeek >= MAX_RECLAIM_EMAILS_PER_WEEK) {
    return { success: false, error: "Weekly reclaim email limit reached" };
  }

  // Generate the reclaim email
  const llm = createGPT4oMiniModel(0.3);
  const prompt = `Write a polite, professional email to request the restoration of a backlink that was accidentally removed.

Context:
- The website ${recovery.sourceDomain} previously linked to ${recovery.targetUrl}
- The link was on this page: ${recovery.sourceUrl}
- The link appears to have been removed during a content update
- The sender is from ${recovery.business.businessName || "a business"}

Requirements:
- Be brief (under 100 words)
- Be polite and understanding (content updates happen)
- Reference the specific URL and page
- Explain why the link was valuable for their readers
- Do NOT be demanding or aggressive

Return a JSON object:
{
  "subject": "Email subject line",
  "body": "Full email body (plain text)"
}

Return ONLY the JSON.`;

  try {
    const response = await llm.invoke(prompt);
    const content = typeof response.content === "string" ? response.content : String(response.content);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("LLM did not return valid JSON");
    const email = JSON.parse(jsonMatch[0]);

    // Send via Resend
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const fromName = recovery.business.businessName || "Uplift AI";
    const fromEmail = process.env.OUTREACH_FROM_EMAIL || "outreach@upliftai.co";

    // Try to find a contact email for the domain
    const contactEmail = `webmaster@${recovery.sourceDomain}`;

    const result = await resend.emails.send({
      from: `${fromName} via Uplift AI <${fromEmail}>`,
      to: contactEmail,
      subject: email.subject,
      text: email.body,
    });

    // Update recovery status with Resend email ID
    await prisma.dRLinkRecovery.update({
      where: { id: recoveryId },
      data: {
        reclaimStatus: DRLinkRecoveryStatus.EMAILED,
        reclaimEmailId: result.data?.id || null,
      },
    });

    // Log action
    await prisma.dRActionLog.create({
      data: {
        businessId: recovery.businessId,
        actionType: DRActionType.LINK_RECLAIM,
        status: DRActionStatus.COMPLETED,
        completedAt: new Date(),
        details: {
          recoveryId,
          sourceDomain: recovery.sourceDomain,
          domainAuthority: recovery.domainAuthority,
        },
      },
    });

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
