import { prisma } from "../config/db.config";
import { fetchDomainRankFromDataForSEO } from "../utils/dataforseo-backlinks.utils";
import {
  buildSubmissionComplianceSnapshot,
  evaluateGuestPostPublisher,
  getHighAuthorityCampaignDefaults,
} from "./guest-posting-quality.service";

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    return urlObj.hostname.replace("www.", "");
  } catch (error) {
    const cleaned = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const domain = cleaned.split("/")[0];
    return domain || url; // Fallback to original URL if split fails
  }
}

/**
 * Service for managing guest posting operations
 */
export class GuestPostingService {
  // ============================================
  // Publisher Management
  // ============================================

  /**
   * Create a new publisher
   */
  async createPublisher(
    userId: string,
    data: {
      name: string;
      websiteUrl: string;
      niche?: string;
      contactEmail?: string;
      contactName?: string;
      submissionUrl?: string;
      submissionGuidelines?: string;
      acceptedFormats?: string[];
      minWordCount?: number;
      maxWordCount?: number;
      requiresPayment?: boolean;
      priceRange?: string;
      acceptsLinks?: boolean;
      maxLinksPerPost?: number;
      linkTypesAllowed?: string[];
      responseTime?: string;
      notes?: string;
    }
  ) {
    const domain = extractDomain(data.websiteUrl);

    // Check if publisher already exists for this user
    const existing = await prisma.guestPostPublisher.findUnique({
      where: {
        userId_websiteUrl: {
          userId,
          websiteUrl: data.websiteUrl,
        },
      },
    });

    if (existing) {
      throw new Error("Publisher with this website URL already exists");
    }

    const publisher = await prisma.guestPostPublisher.create({
      data: {
        userId,
        name: data.name,
        websiteUrl: data.websiteUrl,
        domain,
        niche: data.niche || null,
        contactEmail: data.contactEmail || null,
        contactName: data.contactName || null,
        submissionUrl: data.submissionUrl || null,
        submissionGuidelines: data.submissionGuidelines || null,
        acceptedFormats: data.acceptedFormats || [],
        minWordCount: data.minWordCount || null,
        maxWordCount: data.maxWordCount || null,
        requiresPayment: data.requiresPayment || false,
        priceRange: data.priceRange || null,
        acceptsLinks: data.acceptsLinks ?? true,
        maxLinksPerPost: data.maxLinksPerPost || null,
        linkTypesAllowed: data.linkTypesAllowed || [],
        responseTime: data.responseTime || null,
        notes: data.notes || null,
        source: "MANUAL",
      },
    });

    return this.refreshPublisherQualitySnapshot(publisher.id);
  }

  /**
   * Update a publisher
   */
  async updatePublisher(
    publisherId: string,
    userId: string,
    data: Partial<{
      name: string;
      websiteUrl: string;
      niche: string;
      contactEmail: string;
      contactName: string;
      submissionUrl: string;
      submissionGuidelines: string;
      acceptedFormats: string[];
      minWordCount: number;
      maxWordCount: number;
      requiresPayment: boolean;
      priceRange: string;
      acceptsLinks: boolean;
      maxLinksPerPost: number;
      linkTypesAllowed: string[];
      isActive: boolean;
      responseTime: string;
      acceptanceRate: number;
      notes: string;
    }>
  ) {
    // Verify ownership
    const publisher = await prisma.guestPostPublisher.findFirst({
      where: {
        id: publisherId,
        userId,
      },
    });

    if (!publisher) {
      throw new Error("Publisher not found or access denied");
    }

    const updateData: any = { ...data };
    if (data.websiteUrl) {
      updateData.domain = extractDomain(data.websiteUrl);
    }

    await prisma.guestPostPublisher.update({
      where: { id: publisherId },
      data: updateData,
    });

    return this.refreshPublisherQualitySnapshot(publisherId);
  }

  /**
   * Delete a publisher
   */
  async deletePublisher(publisherId: string, userId: string) {
    // Verify ownership
    const publisher = await prisma.guestPostPublisher.findFirst({
      where: {
        id: publisherId,
        userId,
      },
    });

    if (!publisher) {
      throw new Error("Publisher not found or access denied");
    }

    // Check if publisher has submissions
    const submissions = await prisma.guestPostSubmission.count({
      where: {
        publisherId,
      },
    });

    if (submissions > 0) {
      throw new Error(
        `Cannot delete publisher with ${submissions} existing submission(s)`
      );
    }

    return await prisma.guestPostPublisher.delete({
      where: { id: publisherId },
    });
  }

  /**
   * Get all publishers for a user
   */
  async getPublishers(
    userId: string,
    filters?: {
      niche?: string;
      minDomainAuthority?: number;
      isActive?: boolean;
      source?: string;
      isSuggested?: boolean; // Filter by suggested status
    }
  ) {
    const where: any = { userId };

    if (filters?.niche) {
      where.niche = filters.niche;
    }
    if (filters?.minDomainAuthority !== undefined) {
      where.domainAuthority = { gte: filters.minDomainAuthority };
    }
    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }
    if (filters?.source) {
      where.source = filters.source;
    }
    if (filters?.isSuggested !== undefined) {
      where.isSuggested = filters.isSuggested;
    }

    return await prisma.guestPostPublisher.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            submissions: true,
          },
        },
      },
    });
  }

  /**
   * Get publisher by ID
   */
  async getPublisherById(publisherId: string, userId: string) {
    return await prisma.guestPostPublisher.findFirst({
      where: {
        id: publisherId,
        userId,
      },
      include: {
        _count: {
          select: {
            submissions: true,
          },
        },
      },
    });
  }

  /**
   * Enrich publisher metrics from DataForSEO
   */
  async enrichPublisherMetrics(publisherId: string, userId: string) {
    const publisher = await this.getPublisherById(publisherId, userId);
    if (!publisher) {
      throw new Error("Publisher not found");
    }

    try {
      const domainRank = await fetchDomainRankFromDataForSEO(publisher.domain);
      
      if (domainRank && domainRank.domain_rank) {
        await prisma.guestPostPublisher.update({
          where: { id: publisherId },
          data: {
            domainRank: domainRank.domain_rank,
            domainAuthority: Math.round(domainRank.domain_rank / 10), // Approximate DA from DR (DR/10)
          },
        });
      }

      await this.refreshPublisherQualitySnapshot(publisherId);
      return await this.getPublisherById(publisherId, userId);
    } catch (error) {
      console.error("Error enriching publisher metrics:", error);
      throw new Error("Failed to enrich publisher metrics");
    }
  }

  // ============================================
  // Campaign Management
  // ============================================

  /**
   * Create a new campaign
   */
  async createCampaign(
    userId: string,
    businessId: string,
    data: {
      name: string;
      description?: string;
      targetKeywords?: string[];
      targetNiche?: string;
      minDomainAuthority?: number;
      maxBudget?: number;
      targetLinks?: number;
      startDate?: Date;
      endDate?: Date;
      autoCreateSubmissions?: boolean;
      autoGeneratePitch?: boolean;
      autoSendPitch?: boolean;
      autoApprovePublishers?: boolean;
      autoPitchDelayHours?: number;
      maxSubmissionsPerDay?: number;
      campaignTemplate?: string;
      maxPublisherSpamScore?: number;
      requireNicheMatch?: boolean;
      requireVerifiedPublishers?: boolean;
    }
  ) {
    const ownedBusiness = await prisma.business.findFirst({
      where: { id: businessId, userId, isActive: true },
      select: { id: true },
    });
    if (!ownedBusiness) {
      throw new Error("Business not found or access denied");
    }

    const highAuthorityDefaults = getHighAuthorityCampaignDefaults();
    const campaignTemplate =
      data.campaignTemplate || highAuthorityDefaults.campaignTemplate;
    const isHighAuthority =
      campaignTemplate === highAuthorityDefaults.campaignTemplate;

    return await prisma.guestPostCampaign.create({
      data: {
        userId,
        businessId,
        name: data.name,
        description: data.description || null,
        targetKeywords: data.targetKeywords || [],
        targetNiche: data.targetNiche || null,
        minDomainAuthority:
          data.minDomainAuthority ??
          (isHighAuthority ? highAuthorityDefaults.minDomainAuthority : null),
        maxPublisherSpamScore:
          data.maxPublisherSpamScore ??
          (isHighAuthority ? highAuthorityDefaults.maxPublisherSpamScore : 15),
        maxBudget: data.maxBudget || null,
        targetLinks: data.targetLinks || 10,
        campaignTemplate,
        startDate: data.startDate || null,
        endDate: data.endDate || null,
        status: "DRAFT",
        autoCreateSubmissions: data.autoCreateSubmissions || false,
        autoGeneratePitch:
          data.autoGeneratePitch ??
          (isHighAuthority ? highAuthorityDefaults.autoGeneratePitch : false),
        autoSendPitch: data.autoSendPitch || false,
        autoApprovePublishers: data.autoApprovePublishers || false,
        autoPitchDelayHours: data.autoPitchDelayHours || 0,
        maxSubmissionsPerDay:
          data.maxSubmissionsPerDay ??
          (isHighAuthority
            ? highAuthorityDefaults.maxSubmissionsPerDay
            : 5),
        requireNicheMatch:
          data.requireNicheMatch ??
          (isHighAuthority ? highAuthorityDefaults.requireNicheMatch : false),
        requireVerifiedPublishers:
          data.requireVerifiedPublishers ??
          (isHighAuthority
            ? highAuthorityDefaults.requireVerifiedPublishers
            : false),
      },
    });
  }

  /**
   * Update a campaign
   */
  async updateCampaign(
    campaignId: string,
    userId: string,
    data: Partial<{
      name: string;
      description: string;
      targetKeywords: string[];
      targetNiche: string;
      minDomainAuthority: number;
      maxBudget: number;
      targetLinks: number;
      status: string;
      startDate: Date;
      endDate: Date;
      autoCreateSubmissions: boolean;
      autoGeneratePitch: boolean;
      autoSendPitch: boolean;
      autoApprovePublishers: boolean;
      autoPitchDelayHours: number;
      maxSubmissionsPerDay: number;
      campaignTemplate: string;
      maxPublisherSpamScore: number;
      requireNicheMatch: boolean;
      requireVerifiedPublishers: boolean;
    }>
  ) {
    // Verify ownership
    const campaign = await prisma.guestPostCampaign.findFirst({
      where: {
        id: campaignId,
        userId,
      },
    });

    if (!campaign) {
      throw new Error("Campaign not found or access denied");
    }

    return await prisma.guestPostCampaign.update({
      where: { id: campaignId },
      data,
    });
  }

  /**
   * Delete a campaign
   */
  async deleteCampaign(campaignId: string, userId: string) {
    // Verify ownership
    const campaign = await prisma.guestPostCampaign.findFirst({
      where: {
        id: campaignId,
        userId,
      },
    });

    if (!campaign) {
      throw new Error("Campaign not found or access denied");
    }

    return await prisma.guestPostCampaign.delete({
      where: { id: campaignId },
    });
  }

  /**
   * Get all campaigns for a user
   */
  async getCampaigns(
    userId: string,
    filters?: {
      businessId?: string;
      status?: string;
    }
  ) {
    const where: any = { userId };

    if (filters?.businessId) {
      where.businessId = filters.businessId;
    }
    if (filters?.status) {
      where.status = filters.status;
    }

    return await prisma.guestPostCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        business: {
          select: {
            id: true,
            businessName: true,
          },
        },
        _count: {
          select: {
            submissions: true,
          },
        },
      },
    });
  }

  /**
   * Get campaign by ID
   */
  async getCampaignById(campaignId: string, userId: string) {
    return await prisma.guestPostCampaign.findFirst({
      where: {
        id: campaignId,
        userId,
      },
      include: {
        business: {
          select: {
            id: true,
            businessName: true,
          },
        },
        submissions: {
          include: {
            publisher: {
              select: {
                id: true,
                name: true,
                websiteUrl: true,
                domainAuthority: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });
  }

  /**
   * Update campaign metrics
   */
  async updateCampaignMetrics(campaignId: string) {
    const submissions = await prisma.guestPostSubmission.findMany({
      where: { campaignId },
    });

    const metrics = {
      totalPublishers: new Set(submissions.map((s) => s.publisherId)).size,
      submissionsSent: submissions.filter((s) => s.status !== "DRAFT").length,
      accepted: submissions.filter((s) => s.status === "ACCEPTED" || s.status === "PUBLISHED").length,
      published: submissions.filter((s) => s.status === "PUBLISHED").length,
      rejected: submissions.filter((s) => s.status === "REJECTED").length,
      totalSpent: submissions.reduce((sum, s) => sum + (s.cost || 0), 0),
    };

    return await prisma.guestPostCampaign.update({
      where: { id: campaignId },
      data: metrics,
    });
  }

  // ============================================
  // Submission Management
  // ============================================

  /**
   * Create a new submission
   */
  async createSubmission(
    userId: string,
    data: {
      campaignId?: string;
      publisherId: string;
      blogId?: string;
      title: string;
      proposedTopic?: string;
      pitchEmail?: string;
      customContent?: string;
      cost?: number;
      currency?: string;
      internalNotes?: string;
    }
  ) {
    // Verify publisher ownership
    const publisher = await prisma.guestPostPublisher.findFirst({
      where: {
        id: data.publisherId,
        userId,
      },
    });

    if (!publisher) {
      throw new Error("Publisher not found or access denied");
    }

    let campaign: any = null;

    // Verify campaign ownership if provided
    if (data.campaignId) {
      campaign = await prisma.guestPostCampaign.findFirst({
        where: {
          id: data.campaignId,
          userId,
        },
      });

      if (!campaign) {
        throw new Error("Campaign not found or access denied");
      }
    }

    // A caller must never attach another tenant's content to a submission,
    // even when the publisher and campaign themselves are owned.
    if (data.blogId) {
      const blog = await prisma.blog.findFirst({
        where: { id: data.blogId, userId },
        select: { id: true },
      });
      if (!blog) {
        throw new Error("Blog not found or access denied");
      }
    }

    const compliance = buildSubmissionComplianceSnapshot(
      publisher,
      campaign,
    );

    const submission = await prisma.guestPostSubmission.create({
      data: {
        userId,
        campaignId: data.campaignId || null,
        publisherId: data.publisherId,
        blogId: data.blogId || null,
        title: data.title,
        proposedTopic: data.proposedTopic || null,
        pitchEmail: data.pitchEmail || null,
        customContent: data.customContent || null,
        cost: data.cost || null,
        currency: data.currency || "USD",
        internalNotes: data.internalNotes || null,
        status: "DRAFT",
        ...compliance,
      },
    });

    // Update campaign metrics if part of a campaign
    if (data.campaignId) {
      await this.updateCampaignMetrics(data.campaignId);
    }

    return submission;
  }

  /**
   * Update a submission
   */
  async updateSubmission(
    submissionId: string,
    userId: string,
    data: Partial<{
      title: string;
      proposedTopic: string;
      pitchEmail: string;
      customContent: string;
      cost: number;
      currency: string;
      internalNotes: string;
    }>
  ) {
    // Verify ownership
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId,
      },
    });

    if (!submission) {
      throw new Error("Submission not found or access denied");
    }

    return await prisma.guestPostSubmission.update({
      where: { id: submissionId },
      data,
    });
  }

  /**
   * Update submission status
   */
  async updateSubmissionStatus(
    submissionId: string,
    userId: string,
    status: string,
    metadata?: {
      publishedUrl?: string;
      publishedTitle?: string;
      backlinksReceived?: string[];
      rejectionReason?: string;
    }
  ) {
    // Verify ownership
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId,
      },
    });

    if (!submission) {
      throw new Error("Submission not found or access denied");
    }

    const updateData: any = {
      status,
    };

    const now = new Date();

    // Set timestamps based on status
    if (status === "PITCHED") {
      updateData.pitchSentAt = now;
    } else if (status === "ACCEPTED") {
      updateData.acceptedAt = now;
      updateData.respondedAt = now;
    } else if (status === "REJECTED") {
      updateData.rejectedAt = now;
      updateData.respondedAt = now;
      if (metadata?.rejectionReason) {
        updateData.rejectionReason = metadata.rejectionReason;
      }
    } else if (status === "PUBLISHED") {
      updateData.publishedAt = now;
      if (metadata?.publishedUrl) {
        updateData.publishedUrl = metadata.publishedUrl;
      }
      if (metadata?.publishedTitle) {
        updateData.publishedTitle = metadata.publishedTitle;
      }
      if (metadata?.backlinksReceived) {
        updateData.backlinksReceived = metadata.backlinksReceived;
      }
    }

    const updated = await prisma.guestPostSubmission.update({
      where: { id: submissionId },
      data: updateData,
    });

    // Update campaign metrics if part of a campaign
    if (submission.campaignId) {
      await this.updateCampaignMetrics(submission.campaignId);
    }

    return updated;
  }

  /**
   * Get all submissions for a user
   */
  async getSubmissions(
    userId: string,
    filters?: {
      campaignId?: string;
      publisherId?: string;
      status?: string;
      blogId?: string;
    }
  ) {
    const where: any = { userId };

    if (filters?.campaignId) {
      where.campaignId = filters.campaignId;
    }
    if (filters?.publisherId) {
      where.publisherId = filters.publisherId;
    }
    if (filters?.status) {
      where.status = filters.status;
    }
    if (filters?.blogId) {
      where.blogId = filters.blogId;
    }

    return await prisma.guestPostSubmission.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        publisher: {
          select: {
            id: true,
            name: true,
            websiteUrl: true,
            domainAuthority: true,
          },
        },
        campaign: {
          select: {
            id: true,
            name: true,
          },
        },
        blog: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
    });
  }

  /**
   * Get submission by ID
   */
  async getSubmissionById(submissionId: string, userId: string) {
    return await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId,
      },
      include: {
        publisher: true,
        campaign: {
          include: {
            business: {
              select: {
                id: true,
                businessName: true,
              },
            },
          },
        },
        blog: {
          select: {
            id: true,
            title: true,
            slug: true,
            content: true,
          },
        },
      },
    });
  }

  /**
   * Delete a submission
   */
  async deleteSubmission(submissionId: string, userId: string) {
    // Verify ownership
    const submission = await prisma.guestPostSubmission.findFirst({
      where: {
        id: submissionId,
        userId,
      },
    });

    if (!submission) {
      throw new Error("Submission not found or access denied");
    }

    const deleted = await prisma.guestPostSubmission.delete({
      where: { id: submissionId },
    });

    // Update campaign metrics if part of a campaign
    if (submission.campaignId) {
      await this.updateCampaignMetrics(submission.campaignId);
    }

    return deleted;
  }

  // ============================================
  // Analytics
  // ============================================

  /**
   * Get campaign analytics
   */
  async getCampaignAnalytics(campaignId: string, userId: string) {
    const campaign = await this.getCampaignById(campaignId, userId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }

    const submissions = campaign.submissions || [];

    const analytics = {
      campaign,
      metrics: {
        totalPublishers: campaign.totalPublishers,
        submissionsSent: campaign.submissionsSent,
        accepted: campaign.accepted,
        published: campaign.published,
        rejected: campaign.rejected,
        acceptanceRate:
          campaign.submissionsSent > 0
            ? (campaign.accepted / campaign.submissionsSent) * 100
            : 0,
        publicationRate:
          campaign.submissionsSent > 0
            ? (campaign.published / campaign.submissionsSent) * 100
            : 0,
        totalSpent: campaign.totalSpent,
        costPerBacklink:
          campaign.published > 0
            ? campaign.totalSpent / campaign.published
            : 0,
      },
      submissionsByStatus: {
        DRAFT: submissions.filter((s) => s.status === "DRAFT").length,
        PITCHED: submissions.filter((s) => s.status === "PITCHED").length,
        ACCEPTED: submissions.filter((s) => s.status === "ACCEPTED").length,
        PUBLISHED: submissions.filter((s) => s.status === "PUBLISHED").length,
        REJECTED: submissions.filter((s) => s.status === "REJECTED").length,
      },
    };

    return analytics;
  }

  /**
   * Get publisher performance
   */
  async getPublisherPerformance(publisherId: string, userId: string) {
    const publisher = await this.getPublisherById(publisherId, userId);
    if (!publisher) {
      throw new Error("Publisher not found");
    }

    const submissions = await prisma.guestPostSubmission.findMany({
      where: {
        publisherId,
        userId,
      },
    });

    const performance = {
      publisher,
      metrics: {
        totalSubmissions: submissions.length,
        accepted: submissions.filter(
          (s) => s.status === "ACCEPTED" || s.status === "PUBLISHED"
        ).length,
        published: submissions.filter((s) => s.status === "PUBLISHED").length,
        rejected: submissions.filter((s) => s.status === "REJECTED").length,
        acceptanceRate:
          submissions.length > 0
            ? (submissions.filter(
                (s) => s.status === "ACCEPTED" || s.status === "PUBLISHED"
              ).length /
                submissions.length) *
              100
            : 0,
        averageResponseTime: null as number | null, // Could calculate from timestamps
      },
    };

    return performance;
  }

  private async refreshPublisherQualitySnapshot(publisherId: string) {
    const publisher = await prisma.guestPostPublisher.findUnique({
      where: { id: publisherId },
    });
    if (!publisher) return null;

    const evaluation = evaluateGuestPostPublisher(publisher);
    return prisma.guestPostPublisher.update({
      where: { id: publisherId },
      data: {
        qualityScore: evaluation.score,
        qualityGateStatus: evaluation.status,
        qualityGateReasons: [...evaluation.reasons, ...evaluation.warnings],
        complianceNotes: evaluation.complianceNotes,
      },
    });
  }
}
