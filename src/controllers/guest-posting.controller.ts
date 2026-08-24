import type { Request, Response } from "express";
import { ZodError } from "zod";
import { GuestPostingService } from "../services/guest-posting.service";
import { EmailService } from "../services/email.service";
import { generatePitchEmailLLM } from "../llm/guest-posting/generate-pitch-email.llm";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import {
  CREATE_PUBLISHER,
  UPDATE_PUBLISHER,
  GET_PUBLISHERS,
  GET_PUBLISHER_BY_ID,
  DELETE_PUBLISHER,
  ENRICH_PUBLISHER_METRICS,
  CREATE_CAMPAIGN,
  UPDATE_CAMPAIGN,
  GET_CAMPAIGNS,
  GET_CAMPAIGN_BY_ID,
  DELETE_CAMPAIGN,
  GET_CAMPAIGN_ANALYTICS,
  CREATE_SUBMISSION,
  UPDATE_SUBMISSION,
  UPDATE_SUBMISSION_STATUS,
  GET_SUBMISSIONS,
  GET_SUBMISSION_BY_ID,
  DELETE_SUBMISSION,
  GET_PUBLISHER_PERFORMANCE,
} from "../validators/guest-posting.validation";
import { getDatabaseUserId } from "../utils/user.utils";
import { prisma } from "../config/db.config";
import { generatePitchEmailSubject } from "../utils/email-templates";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";

const guestPostingService = new GuestPostingService();
const emailService = new EmailService();

// Every route in this controller is behind requireBackendAuth. Never recover
// tenant identity from body/query values; bindAuthenticatedUser only rejects
// conflicting legacy inputs.
function authenticatedUserId(req: Request): string {
  return (req as AuthenticatedRequest).authUserId!;
}

function logGuestPostingError(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (/not found|access denied|ownership mismatch/i.test(message)) return;

  // Keep unexpected failures useful without serializing provider payloads or
  // expensive stack traces into production logs.
  console.error(`[Guest Posting] ${operation} failed: ${message}`);
}

// ============================================
// Publisher Controllers
// ============================================

export async function createPublisher(req: Request, res: Response) {
  try {
    const body = CREATE_PUBLISHER.parse(req.body);
    const userId = authenticatedUserId(req);

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publisher = await guestPostingService.createPublisher(
      databaseUserId,
      body
    );

    return sendSuccess(res, publisher, "Publisher created successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("create publisher", error);
    return sendError(res, error.message || "Failed to create publisher", 500);
  }
}

export async function getPublishers(req: Request, res: Response) {
  try {
    const query = GET_PUBLISHERS.parse({
      userId: authenticatedUserId(req),
      niche: req.query.niche,
      minDomainAuthority: req.query.minDomainAuthority
        ? parseInt(req.query.minDomainAuthority as string)
        : undefined,
      isActive:
        req.query.isActive !== undefined
          ? req.query.isActive === "true"
          : undefined,
      source: req.query.source,
      isSuggested:
        req.query.isSuggested !== undefined
          ? req.query.isSuggested === "true"
          : undefined,
    });

    const databaseUserId = await getDatabaseUserId(query.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publishers = await guestPostingService.getPublishers(
      databaseUserId,
      {
        niche: query.niche,
        minDomainAuthority: query.minDomainAuthority,
        isActive: query.isActive,
        source: query.source,
        isSuggested: query.isSuggested,
      }
    );

    return sendSuccess(res, publishers, "Publishers retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get publishers", error);
    return sendError(res, error.message || "Failed to get publishers", 500);
  }
}

export async function getPublisherById(req: Request, res: Response) {
  try {
    if (!req.params.id) {
      return sendError(res, "Publisher ID is required", 400);
    }

    const params = GET_PUBLISHER_BY_ID.parse({
      userId: authenticatedUserId(req),
      publisherId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publisher = await guestPostingService.getPublisherById(
      params.publisherId,
      databaseUserId
    );

    if (!publisher) {
      return sendError(res, "Publisher not found", 404);
    }

    return sendSuccess(res, publisher, "Publisher retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get publisher", error);
    return sendError(res, error.message || "Failed to get publisher", 500);
  }
}

export async function updatePublisher(req: Request, res: Response) {
  try {
    const body = UPDATE_PUBLISHER.parse(req.body);
    const userId = authenticatedUserId(req);
    const publisherId = req.params.id;

    if (!publisherId) {
      return sendError(res, "Publisher ID is required", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publisher = await guestPostingService.updatePublisher(
      publisherId,
      databaseUserId,
      body
    );

    return sendSuccess(res, publisher, "Publisher updated successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("update publisher", error);
    return sendError(res, error.message || "Failed to update publisher", 500);
  }
}

export async function deletePublisher(req: Request, res: Response) {
  try {
    const params = DELETE_PUBLISHER.parse({
      userId: authenticatedUserId(req),
      publisherId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    await guestPostingService.deletePublisher(
      params.publisherId,
      databaseUserId
    );

    return sendSuccess(res, null, "Publisher deleted successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("delete publisher", error);
    return sendError(res, error.message || "Failed to delete publisher", 500);
  }
}

export async function enrichPublisherMetrics(req: Request, res: Response) {
  try {
    const params = ENRICH_PUBLISHER_METRICS.parse({
      userId: authenticatedUserId(req),
      publisherId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const publisher = await guestPostingService.enrichPublisherMetrics(
      params.publisherId,
      databaseUserId
    );

    return sendSuccess(
      res,
      publisher,
      "Publisher metrics enriched successfully"
    );
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("enrich publisher metrics", error);
    return sendError(
      res,
      error.message || "Failed to enrich publisher metrics",
      500
    );
  }
}

// ============================================
// Campaign Controllers
// ============================================

export async function createCampaign(req: Request, res: Response) {
  try {
    const body = CREATE_CAMPAIGN.parse({
      ...req.body,
      userId: authenticatedUserId(req),
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const campaign = await guestPostingService.createCampaign(
      databaseUserId,
      body.businessId,
      {
        name: body.name,
        description: body.description,
        targetKeywords: body.targetKeywords,
        targetNiche: body.targetNiche,
        minDomainAuthority: body.minDomainAuthority,
        maxPublisherSpamScore: body.maxPublisherSpamScore,
        maxBudget: body.maxBudget,
        targetLinks: body.targetLinks,
        campaignTemplate: body.campaignTemplate,
        startDate: body.startDate ? new Date(body.startDate) : undefined,
        endDate: body.endDate ? new Date(body.endDate) : undefined,
        autoCreateSubmissions: body.autoCreateSubmissions,
        autoGeneratePitch: body.autoGeneratePitch,
        autoSendPitch: body.autoSendPitch,
        autoApprovePublishers: body.autoApprovePublishers,
        autoPitchDelayHours: body.autoPitchDelayHours,
        maxSubmissionsPerDay: body.maxSubmissionsPerDay,
        requireNicheMatch: body.requireNicheMatch,
        requireVerifiedPublishers: body.requireVerifiedPublishers,
      }
    );

    return sendSuccess(res, campaign, "Campaign created successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("create campaign", error);
    return sendError(res, error.message || "Failed to create campaign", 500);
  }
}

export async function getCampaigns(req: Request, res: Response) {
  try {
    const query = GET_CAMPAIGNS.parse({
      userId: authenticatedUserId(req),
      businessId: req.query.businessId,
      status: req.query.status,
    });

    const databaseUserId = await getDatabaseUserId(query.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const campaigns = await guestPostingService.getCampaigns(databaseUserId, {
      businessId: query.businessId,
      status: query.status,
    });

    return sendSuccess(res, campaigns, "Campaigns retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get campaigns", error);
    return sendError(res, error.message || "Failed to get campaigns", 500);
  }
}

export async function getCampaignById(req: Request, res: Response) {
  try {
    const params = GET_CAMPAIGN_BY_ID.parse({
      userId: authenticatedUserId(req),
      campaignId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const campaign = await guestPostingService.getCampaignById(
      params.campaignId,
      databaseUserId
    );

    if (!campaign) {
      return sendError(res, "Campaign not found", 404);
    }

    return sendSuccess(res, campaign, "Campaign retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get campaign", error);
    return sendError(res, error.message || "Failed to get campaign", 500);
  }
}

export async function updateCampaign(req: Request, res: Response) {
  try {
    const campaignId = req.params.id;

    if (!campaignId) {
      return sendError(res, "Campaign ID is required", 400);
    }

    const body = UPDATE_CAMPAIGN.parse({
      ...req.body,
      userId: authenticatedUserId(req),
      campaignId,
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const updateData: any = { ...body };
    delete updateData.userId;
    delete updateData.campaignId;

    if (updateData.startDate) {
      updateData.startDate = new Date(updateData.startDate);
    }
    if (updateData.endDate) {
      updateData.endDate = new Date(updateData.endDate);
    }

    const campaign = await guestPostingService.updateCampaign(
      campaignId,
      databaseUserId,
      updateData
    );

    return sendSuccess(res, campaign, "Campaign updated successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("update campaign", error);
    return sendError(res, error.message || "Failed to update campaign", 500);
  }
}

export async function deleteCampaign(req: Request, res: Response) {
  try {
    const params = DELETE_CAMPAIGN.parse({
      userId: authenticatedUserId(req),
      campaignId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    await guestPostingService.deleteCampaign(params.campaignId, databaseUserId);

    return sendSuccess(res, null, "Campaign deleted successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("delete campaign", error);
    return sendError(res, error.message || "Failed to delete campaign", 500);
  }
}

export async function getCampaignAnalytics(req: Request, res: Response) {
  try {
    const params = GET_CAMPAIGN_ANALYTICS.parse({
      userId: authenticatedUserId(req),
      campaignId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const analytics = await guestPostingService.getCampaignAnalytics(
      params.campaignId,
      databaseUserId
    );

    return sendSuccess(res, analytics, "Analytics retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get campaign analytics", error);
    return sendError(
      res,
      error.message || "Failed to get campaign analytics",
      500
    );
  }
}

// ============================================
// Submission Controllers
// ============================================

export async function createSubmission(req: Request, res: Response) {
  try {
    const body = CREATE_SUBMISSION.parse({
      ...req.body,
      userId: authenticatedUserId(req),
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const submission = await guestPostingService.createSubmission(
      databaseUserId,
      {
        campaignId: body.campaignId,
        publisherId: body.publisherId,
        blogId: body.blogId,
        title: body.title,
        proposedTopic: body.proposedTopic,
        pitchEmail: body.pitchEmail,
        customContent: body.customContent,
        cost: body.cost,
        currency: body.currency,
        internalNotes: body.internalNotes,
      }
    );

    return sendSuccess(res, submission, "Submission created successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("create submission", error);
    return sendError(res, error.message || "Failed to create submission", 500);
  }
}

export async function getSubmissions(req: Request, res: Response) {
  try {
    const query = GET_SUBMISSIONS.parse({
      userId: authenticatedUserId(req),
      campaignId: req.query.campaignId,
      publisherId: req.query.publisherId,
      status: req.query.status,
      blogId: req.query.blogId,
    });

    const databaseUserId = await getDatabaseUserId(query.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const submissions = await guestPostingService.getSubmissions(
      databaseUserId,
      {
        campaignId: query.campaignId,
        publisherId: query.publisherId,
        status: query.status,
        blogId: query.blogId,
      }
    );

    return sendSuccess(res, submissions, "Submissions retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get submissions", error);
    return sendError(res, error.message || "Failed to get submissions", 500);
  }
}

export async function getSubmissionById(req: Request, res: Response) {
  try {
    const params = GET_SUBMISSION_BY_ID.parse({
      userId: authenticatedUserId(req),
      submissionId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const submission = await guestPostingService.getSubmissionById(
      params.submissionId,
      databaseUserId
    );

    if (!submission) {
      return sendError(res, "Submission not found", 404);
    }

    return sendSuccess(res, submission, "Submission retrieved successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get submission", error);
    return sendError(res, error.message || "Failed to get submission", 500);
  }
}

export async function updateSubmission(req: Request, res: Response) {
  try {
    const submissionId = req.params.id;

    if (!submissionId) {
      return sendError(res, "Submission ID is required", 400);
    }

    const body = UPDATE_SUBMISSION.parse({
      ...req.body,
      userId: authenticatedUserId(req),
      submissionId,
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const updateData: any = { ...body };
    delete updateData.userId;
    delete updateData.submissionId;

    const submission = await guestPostingService.updateSubmission(
      submissionId,
      databaseUserId,
      updateData
    );

    return sendSuccess(res, submission, "Submission updated successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("update submission", error);
    return sendError(res, error.message || "Failed to update submission", 500);
  }
}

export async function updateSubmissionStatus(req: Request, res: Response) {
  try {
    const submissionId = req.params.id;

    if (!submissionId) {
      return sendError(res, "Submission ID is required", 400);
    }

    const body = UPDATE_SUBMISSION_STATUS.parse({
      ...req.body,
      userId: authenticatedUserId(req),
      submissionId,
    });

    const databaseUserId = await getDatabaseUserId(body.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const submission = await guestPostingService.updateSubmissionStatus(
      submissionId,
      databaseUserId,
      body.status,
      {
        publishedUrl: body.publishedUrl || undefined,
        publishedTitle: body.publishedTitle,
        backlinksReceived: body.backlinksReceived,
        rejectionReason: body.rejectionReason,
      }
    );

    return sendSuccess(
      res,
      submission,
      "Submission status updated successfully"
    );
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("update submission status", error);
    return sendError(
      res,
      error.message || "Failed to update submission status",
      500
    );
  }
}

export async function deleteSubmission(req: Request, res: Response) {
  try {
    const params = DELETE_SUBMISSION.parse({
      userId: authenticatedUserId(req),
      submissionId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    await guestPostingService.deleteSubmission(
      params.submissionId,
      databaseUserId
    );

    return sendSuccess(res, null, "Submission deleted successfully");
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("delete submission", error);
    return sendError(res, error.message || "Failed to delete submission", 500);
  }
}

// ============================================
// Analytics Controllers
// ============================================

export async function getPublisherPerformance(req: Request, res: Response) {
  try {
    const params = GET_PUBLISHER_PERFORMANCE.parse({
      userId: authenticatedUserId(req),
      publisherId: req.params.id,
    });

    const databaseUserId = await getDatabaseUserId(params.userId);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const performance = await guestPostingService.getPublisherPerformance(
      params.publisherId,
      databaseUserId
    );

    return sendSuccess(
      res,
      performance,
      "Publisher performance retrieved successfully"
    );
  } catch (error: any) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }
    logGuestPostingError("get publisher performance", error);
    return sendError(
      res,
      error.message || "Failed to get publisher performance",
      500
    );
  }
}

// ============================================
// Email Automation Controllers
// ============================================

/**
 * Generate AI pitch email for a submission
 * POST /api/v1/guest-posting/submissions/:id/generate-pitch
 */
export async function generatePitchEmail(req: Request, res: Response) {
  try {
    const submissionId = req.params.id;
    const userId = authenticatedUserId(req);

    if (!submissionId) {
      return sendError(res, "Submission ID is required", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Get submission with all related data
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId: databaseUserId,
      },
      include: {
        publisher: true,
        blog: {
          include: {
            meta: true,
            customField: true,
          },
        },
        campaign: {
          include: {
            business: true,
          },
        },
      },
    });

    if (!submission) {
      return sendError(res, "Submission not found", 404);
    }

    // Get business and user info
    const business = submission.campaign?.business || await prisma.business.findFirst({
      where: { userId: databaseUserId },
    });

    if (!business) {
      return sendError(res, "Business not found", 404);
    }

    const user = await prisma.user.findUnique({
      where: { id: databaseUserId },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    // Generate pitch email using AI
    const pitchEmail = await generatePitchEmailLLM({
      publisher: submission.publisher,
      business: business,
      submission: {
        title: submission.title,
        proposedTopic: submission.proposedTopic || undefined,
        blogId: submission.blogId || undefined,
      },
      blog: submission.blog,
      user: {
        firstName: user.name?.split(" ")[0] ?? undefined,
        lastName: user.name?.split(" ").slice(1).join(" ") || undefined,
        email: user.email || undefined,
      },
    });

    // Update submission with generated pitch
    const updatedSubmission = await prisma.guestPostSubmission.update({
      where: { id: submissionId },
      data: {
        pitchEmail: pitchEmail.textContent,
        autoGeneratedPitch: true,
      },
    });

    return sendSuccess(
      res,
      {
        submission: updatedSubmission,
        pitchEmail: {
          subject: pitchEmail.subject,
          htmlContent: pitchEmail.htmlContent,
          textContent: pitchEmail.textContent,
          personalization: pitchEmail.personalization,
        },
      },
      "Pitch email generated successfully"
    );
  } catch (error: any) {
    logGuestPostingError("generate pitch email", error);
    return sendError(res, error.message || "Failed to generate pitch email", 500);
  }
}

/**
 * Send pitch email for a submission
 * POST /api/v1/guest-posting/submissions/:id/send-pitch
 */
export async function sendPitchEmail(req: Request, res: Response) {
  try {
    const submissionId = req.params.id;
    const userId = authenticatedUserId(req);
    const { customSubject, customContent } = req.body;

    if (!submissionId) {
      return sendError(res, "Submission ID is required", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Get submission with all related data
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId: databaseUserId,
      },
      include: {
        publisher: true,
        blog: {
          include: {
            meta: true,
            customField: true,
          },
        },
        campaign: {
          include: {
            business: true,
          },
        },
      },
    });

    if (!submission) {
      return sendError(res, "Submission not found", 404);
    }

    if (!submission.publisher.contactEmail) {
      return sendError(res, "Publisher contact email is required", 400);
    }

    // Get or generate pitch email
    let pitchEmailContent: {
      subject: string;
      htmlContent: string;
      textContent: string;
    };

    if (customContent) {
      // Use custom content if provided
      pitchEmailContent = {
        subject: customSubject || generatePitchEmailSubject({
          publisherName: submission.publisher.name,
          publisherWebsite: submission.publisher.websiteUrl ?? "",
          userName: "Content Creator",
          userBusinessName: submission.campaign?.business?.businessName || "Business",
          blogTitle: submission.title,
        }),
        htmlContent: customContent.replace(/\n/g, "<br>"),
        textContent: customContent,
      };
    } else if (submission.pitchEmail) {
      // Use existing pitch email
      const business = submission.campaign?.business || await prisma.business.findFirst({
        where: { userId: databaseUserId },
      });

      pitchEmailContent = {
        subject: generatePitchEmailSubject({
          publisherName: submission.publisher.name,
          publisherWebsite: submission.publisher.websiteUrl ?? "",
          userName: "Content Creator",
          userBusinessName: business?.businessName || "Business",
          blogTitle: submission.title,
        }),
        htmlContent: submission.pitchEmail.replace(/\n/g, "<br>"),
        textContent: submission.pitchEmail,
      };
    } else {
      // Generate new pitch email
      const business = submission.campaign?.business || await prisma.business.findFirst({
        where: { userId: databaseUserId },
      });

      if (!business) {
        return sendError(res, "Business not found", 404);
      }

      const user = await prisma.user.findUnique({
        where: { id: databaseUserId },
      });

      const generated = await generatePitchEmailLLM({
        publisher: submission.publisher,
        business: business,
        submission: {
          title: submission.title,
          proposedTopic: submission.proposedTopic || undefined,
          blogId: submission.blogId || undefined,
        },
        blog: submission.blog,
        user: {
          firstName: user?.name?.split(" ")[0] ?? undefined,
          lastName: user?.name?.split(" ").slice(1).join(" ") || undefined,
          email: user?.email || undefined,
        },
      });

      pitchEmailContent = {
        subject: generated.subject,
        htmlContent: generated.htmlContent,
        textContent: generated.textContent,
      };
    }

    // Send email
    const emailResult = await emailService.sendPitchEmail(
      submissionId,
      submission.publisher.contactEmail,
      pitchEmailContent.subject,
      pitchEmailContent.htmlContent,
      pitchEmailContent.textContent
    );

    if (!emailResult.success) {
      return sendError(res, emailResult.error || "Failed to send email", 500);
    }

    // Get updated submission
    const updatedSubmission = await prisma.guestPostSubmission.findUnique({
      where: { id: submissionId },
    });

    return sendSuccess(
      res,
      {
        submission: updatedSubmission,
        emailId: emailResult.emailId,
      },
      "Pitch email sent successfully"
    );
  } catch (error: any) {
    logGuestPostingError("send pitch email", error);
    return sendError(res, error.message || "Failed to send pitch email", 500);
  }
}

/**
 * Handle email webhook from Resend
 * POST /api/v1/guest-posting/email-webhook
 */
/**
 * Get suggested publishers (auto-discovered)
 */
export async function getSuggestedPublishers(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req);

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Get all suggested publishers
    const publishers = await guestPostingService.getPublishers(databaseUserId, {
      isSuggested: true,
    });

    // Sort by suggestedAt (newest first)
    const sortedPublishers = publishers.sort((a, b) => {
      if (!a.suggestedAt) return 1;
      if (!b.suggestedAt) return -1;
      return b.suggestedAt.getTime() - a.suggestedAt.getTime();
    });

    return sendSuccess(
      res,
      {
        publishers: sortedPublishers,
        count: sortedPublishers.length,
      },
      `Found ${sortedPublishers.length} suggested publishers`
    );
  } catch (error: any) {
    logGuestPostingError("get suggested publishers", error);
    return sendError(
      res,
      error.message || "Failed to get suggested publishers",
      500
    );
  }
}

/**
 * Mark suggested publishers as reviewed (remove suggested flag)
 */
export async function markSuggestionsAsReviewed(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req);
    const publisherIds = req.body.publisherIds; // Array of publisher IDs, or null to mark all

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    const where: any = {
      userId: databaseUserId,
      isSuggested: true,
    };

    // If specific publisher IDs provided, only mark those
    if (publisherIds && Array.isArray(publisherIds) && publisherIds.length > 0) {
      where.id = { in: publisherIds };
    }

    // Mark as reviewed (remove suggested flag)
    const result = await prisma.guestPostPublisher.updateMany({
      where,
      data: {
        isSuggested: false,
        // Keep suggestedAt for history, but remove suggested flag
      },
    });

    return sendSuccess(
      res,
      {
        markedAsReviewed: result.count,
      },
      `Marked ${result.count} publisher(s) as reviewed`
    );
  } catch (error: any) {
    logGuestPostingError("mark suggestions as reviewed", error);
    return sendError(
      res,
      error.message || "Failed to mark suggestions as reviewed",
      500
    );
  }
}

export function getResendSubmissionId(tags: unknown): string | undefined {
  if (Array.isArray(tags)) {
    const value = tags.find(
      (tag): tag is { name: string; value: unknown } =>
        Boolean(tag) &&
        typeof tag === "object" &&
        "name" in tag &&
        tag.name === "submission_id" &&
        "value" in tag,
    )?.value;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  if (tags && typeof tags === "object" && "submission_id" in tags) {
    const value = (tags as { submission_id?: unknown }).submission_id;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  return undefined;
}

export async function handleEmailWebhook(req: Request, res: Response) {
  try {
    const event = req.body;
    const { type, data } = event;

    // Resend's current webhook contract sends tags as a string record. Keep
    // compatibility with the legacy array shape used by older stored fixtures.
    const submissionId = getResendSubmissionId(data?.tags);

    if (!submissionId) {
      console.warn("⚠️ No submission ID found in webhook event");
      return sendSuccess(res, { processed: false }, "Event processed (no submission ID)");
    }

    // Track email event
    switch (type) {
      case "email.opened":
        await emailService.trackEmailEvent(data.email_id, "opened", {
          submissionId,
          timestamp: new Date(data.created_at),
        });
        break;

      case "email.clicked":
        await emailService.trackEmailEvent(data.email_id, "clicked", {
          submissionId,
          timestamp: new Date(data.created_at),
        });
        break;

      case "email.delivered":
        // Email was delivered successfully
        console.log(`✅ Email delivered for submission ${submissionId}`);
        break;

      case "email.bounced":
      case "email.complained":
        // Handle bounces/complaints
        console.warn(`⚠️ Email ${type} for submission ${submissionId}`);
        break;

      case "email.replied":
        // Handle email replies (if Resend supports this event)
        if (data.reply_content) {
          // Import email reply service and parse the reply
          const { EmailReplyService } = await import("../services/email-reply.service");
          const replyService = new EmailReplyService();
          
          // Get submission to parse reply
          const submission = await prisma.guestPostSubmission.findUnique({
            where: { id: submissionId },
            include: {
              publisher: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          });

          if (submission) {
            const { parseEmailReplyLLM } = await import("../llm/guest-posting/parse-email-reply.llm");
            const parsedStatus = await parseEmailReplyLLM(data.reply_content, submission);

            // Update submission
            await prisma.guestPostSubmission.update({
              where: { id: submissionId },
              data: {
                emailRepliedAt: new Date(data.created_at || Date.now()),
                emailReplyContent: data.reply_content,
                ...(parsedStatus.status === "ACCEPTED" && {
                  status: "ACCEPTED",
                  acceptedAt: new Date(),
                }),
                ...(parsedStatus.status === "REJECTED" && {
                  status: "REJECTED",
                  rejectedAt: new Date(),
                  rejectionReason: parsedStatus.rejectionReason,
                }),
                ...(parsedStatus.publishedUrl && {
                  publishedUrl: parsedStatus.publishedUrl,
                  status: "PUBLISHED",
                  publishedAt: new Date(),
                }),
              },
            });

            console.log(`✅ Email reply processed for submission ${submissionId}, status: ${parsedStatus.status}`);
          }
        }
        break;

      default:
        console.log(`ℹ️ Unhandled email event: ${type} for submission ${submissionId}`);
    }

    return sendSuccess(res, { processed: true }, "Webhook processed successfully");
  } catch (error: any) {
    logGuestPostingError("process email webhook", error);
    return sendError(res, error.message || "Failed to process webhook", 500);
  }
}

/**
 * Manually check if a submission has been published
 * POST /api/v1/guest-posting/submissions/:id/check-published
 */
export async function checkPublishedPost(req: Request, res: Response) {
  try {
    const submissionId = req.params.id;
    const userId = authenticatedUserId(req);

    if (!submissionId) {
      return sendError(res, "Submission ID is required", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Get submission with publisher
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId: databaseUserId,
      },
      include: {
        publisher: true,
        blog: true,
        campaign: {
          include: {
            business: true,
          },
        },
      },
    });

    if (!submission) {
      return sendError(res, "Submission not found", 404);
    }

    // Import published post detector
    const { detectPublishedPost } = await import("../utils/published-post-detector");

    // Check for published post
    const result = await detectPublishedPost(submission.publisher, submission);

    if (result.found && result.publishedUrl) {
      // Extract backlinks if we have the business website
      let backlinks: string[] = [];
      let businessWebsiteUrl: string | null = null;

      // Try to get business website from campaign first
      if (submission.campaign?.business?.businessWebsiteUrl) {
        businessWebsiteUrl = submission.campaign.business.businessWebsiteUrl;
      } else {
        // If no campaign, fetch business directly from user
        const business = await prisma.business.findFirst({
          where: { 
            userId: submission.userId,
            isPrimary: true,
            isActive: true,
          },
          select: { businessWebsiteUrl: true },
        });
        businessWebsiteUrl = business?.businessWebsiteUrl || null;
      }

      if (businessWebsiteUrl) {
        const { extractBacklinks: extractBacklinksUtil } = await import("../utils/backlink-extractor");
        const backlinkResult = await extractBacklinksUtil(
          result.publishedUrl,
          businessWebsiteUrl
        );
        backlinks = backlinkResult.backlinks || [];
      }

      // Update submission status
      const updatedSubmission = await prisma.guestPostSubmission.update({
        where: { id: submissionId },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          publishedUrl: result.publishedUrl,
          publishedTitle: result.publishedTitle || submission.title,
          backlinksReceived: backlinks,
          lastCheckedAt: new Date(),
        },
      });

      return sendSuccess(
        res,
        {
          submission: updatedSubmission,
          found: true,
          publishedUrl: result.publishedUrl,
          backlinks: result.backlinks || [],
        },
        "Published post found and updated"
      );
    }

    // Update last checked timestamp even if not found
    await prisma.guestPostSubmission.update({
      where: { id: submissionId },
      data: {
        lastCheckedAt: new Date(),
      },
    });

    return sendSuccess(
      res,
      {
        found: false,
        message: "Published post not found yet",
      },
      "Check completed"
    );
  } catch (error: any) {
    logGuestPostingError("check published post", error);
    return sendError(res, error.message || "Failed to check published post", 500);
  }
}

/**
 * Check IMAP configuration status
 * GET /api/v1/guest-posting/imap-status
 */
export async function checkIMAPStatus(req: Request, res: Response) {
  try {
    const { EmailReplyService } = await import("../services/email-reply.service");
    const replyService = new EmailReplyService();

    return sendSuccess(
      res,
      {
        configured: replyService.isConfigured(),
        message: replyService.isConfigured()
          ? "IMAP is configured and ready"
          : "IMAP is not configured. Please set IMAP_HOST, IMAP_USER, and IMAP_PASSWORD environment variables.",
      },
      "IMAP status retrieved"
    );
  } catch (error: any) {
    logGuestPostingError("check IMAP status", error);
    return sendError(res, error.message || "Failed to check IMAP status", 500);
  }
}

/**
 * Manually check for email replies for a submission
 * POST /api/v1/guest-posting/submissions/:id/check-reply
 */
export async function checkEmailReply(req: Request, res: Response) {
  try {
    const submissionId = req.params.id;
    const userId = authenticatedUserId(req);

    if (!submissionId) {
      return sendError(res, "Submission ID is required", 400);
    }

    const databaseUserId = await getDatabaseUserId(userId as string);
    if (!databaseUserId) {
      return sendError(res, "User not found", 404);
    }

    // Verify submission ownership
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId: databaseUserId,
      },
    });

    if (!submission) {
      return sendError(res, "Submission not found", 404);
    }

    // Import email reply service
    const { EmailReplyService } = await import("../services/email-reply.service");
    const replyService = new EmailReplyService();

    if (!replyService.isConfigured()) {
      return sendError(
        res,
        "IMAP is not configured. Please set IMAP_HOST, IMAP_USER, and IMAP_PASSWORD environment variables.",
        400
      );
    }

    // Check for reply
    const result = await replyService.checkReplyForSubmission(submissionId);

    if (!result.found) {
      return sendSuccess(
        res,
        {
          found: false,
          message: "No reply found yet",
        },
        "No reply found"
      );
    }

    // Get updated submission
    const updatedSubmission = await prisma.guestPostSubmission.findUnique({
      where: { id: submissionId },
      include: {
        publisher: true,
      },
    });

    return sendSuccess(
      res,
      {
        submission: updatedSubmission,
        found: true,
        replyContent: result.replyContent,
        parsedStatus: result.parsedStatus,
      },
      "Reply found and processed"
    );
  } catch (error: any) {
    logGuestPostingError("check email reply", error);
    return sendError(res, error.message || "Failed to check email reply", 500);
  }
}
