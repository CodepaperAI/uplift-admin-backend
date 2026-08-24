import { prisma } from "../config/db.config";
import {
  getKeywordsForDomainFromDataForSEO,
  getCompetitorsFromDataForSEO,
  getDomainRankingsFromDataForSEO,
} from "../utils/dataforseo.utils";
import { scrapeWebsite } from "../utils/tools.utils";
import { SmartKeywordDiscoveryService } from "./smart-keyword-discovery.service";

export interface ServiceTaxonomy {
  primaryService: string;
  subServices: string[];
  technologies: string[];
  targetAudiences: string[];
  serviceDescription?: string;
  industryContext?: string;
}

export interface CompetitorAnalysis {
  competitorDomain: string;
  competitorName: string;
  rankingKeywords: string[];
  contentUrls: string[];
  contentTopics: string[];
  domainAuthority?: number;
  totalKeywords?: number;
  averagePosition?: number;
  strengthAreas: string[];
  contentStrategy?: any;
}

/**
 * Service for building competitor intelligence and dynamic knowledge base
 */
export class CompetitorIntelligenceService {
  private smartDiscovery: SmartKeywordDiscoveryService;

  constructor() {
    this.smartDiscovery = new SmartKeywordDiscoveryService();
  }

  /**
   * Build service taxonomy from real services scraped from website
   * LLM enhances the real services into a detailed taxonomy
   */
  async buildServiceTaxonomy(
    businessId: string,
    realServices: string[]
  ): Promise<ServiceTaxonomy[]> {
    console.log(`🔍 Building service taxonomy for ${realServices.length} real services...`);

    const taxonomies: ServiceTaxonomy[] = [];

    for (const service of realServices) {
      // TODO: Use LLM to enhance service into taxonomy
      // For now, create basic taxonomy structure
      const taxonomy: ServiceTaxonomy = {
        primaryService: service,
        subServices: [], // LLM will expand this
        technologies: [], // LLM will identify technologies
        targetAudiences: [], // LLM will identify audiences
        serviceDescription: `Service: ${service}`, // LLM will enhance
        industryContext: undefined, // LLM will add context
      };

      // Save to database
      await prisma.serviceTaxonomy.upsert({
        where: {
          businessId_primaryService: {
            businessId,
            primaryService: service,
          },
        },
        update: {
          subServices: taxonomy.subServices as any,
          technologies: taxonomy.technologies,
          targetAudiences: taxonomy.targetAudiences,
          serviceDescription: taxonomy.serviceDescription,
          industryContext: taxonomy.industryContext,
          updatedAt: new Date(),
        },
        create: {
          businessId,
          primaryService: taxonomy.primaryService,
          subServices: taxonomy.subServices as any,
          technologies: taxonomy.technologies,
          targetAudiences: taxonomy.targetAudiences,
          serviceDescription: taxonomy.serviceDescription,
          industryContext: taxonomy.industryContext,
        },
      });

      taxonomies.push(taxonomy);
    }

    console.log(`✅ Built ${taxonomies.length} service taxonomies`);
    return taxonomies;
  }

  /**
   * Analyze a single competitor
   */
  async analyzeCompetitor(
    businessId: string,
    competitorDomain: string,
    competitorName: string,
    locationCode: number
  ): Promise<CompetitorAnalysis> {
    console.log(`🔍 Analyzing competitor: ${competitorDomain}...`);

    // Get competitor keywords
    const competitorKeywords = await getKeywordsForDomainFromDataForSEO(
      competitorDomain,
      locationCode,
      "en",
      200
    );

    // Get domain rankings
    const rankings = await getDomainRankingsFromDataForSEO(
      competitorDomain,
      competitorKeywords.slice(0, 10).map((k) => k.keyword),
      locationCode
    );

    // Scrape competitor website for content analysis
    let contentUrls: string[] = [];
    let contentTopics: string[] = [];
    let strengthAreas: string[] = [];

    try {
      const scraped = await scrapeWebsite(`https://${competitorDomain}`);
      // Extract content topics from headings
      if (scraped.headers) {
        const allHeadings = [
          ...(scraped.headers.h1 || []),
          ...(scraped.headers.h2 || []),
          ...(scraped.headers.h3 || []),
        ];
        contentTopics = allHeadings.slice(0, 20); // Top 20 topics
        strengthAreas = allHeadings.slice(0, 10); // Top 10 strength areas
      }
    } catch (error: any) {
      console.warn(`⚠️ Failed to scrape ${competitorDomain}: ${error.message}`);
    }

    const analysis: CompetitorAnalysis = {
      competitorDomain,
      competitorName,
      rankingKeywords: competitorKeywords.map((k) => k.keyword),
      contentUrls,
      contentTopics,
      domainAuthority: undefined, // TODO: Get from DataForSEO domain metrics
      totalKeywords: competitorKeywords.length,
      averagePosition: rankings.averagePosition || undefined,
      strengthAreas,
      contentStrategy: undefined, // TODO: LLM analysis
    };

    // Save to database
    await prisma.competitorIntelligence.upsert({
      where: {
        businessId_competitorDomain: {
          businessId,
          competitorDomain,
        },
      },
      update: {
        competitorName: analysis.competitorName,
        rankingKeywords: analysis.rankingKeywords,
        contentUrls: analysis.contentUrls as any,
        contentTopics: analysis.contentTopics,
        domainAuthority: analysis.domainAuthority,
        totalKeywords: analysis.totalKeywords,
        averagePosition: analysis.averagePosition,
        strengthAreas: analysis.strengthAreas,
        contentStrategy: analysis.contentStrategy as any,
        lastAnalyzedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        businessId,
        competitorDomain: analysis.competitorDomain,
        competitorName: analysis.competitorName,
        rankingKeywords: analysis.rankingKeywords,
        contentUrls: analysis.contentUrls as any,
        contentTopics: analysis.contentTopics,
        domainAuthority: analysis.domainAuthority,
        totalKeywords: analysis.totalKeywords,
        averagePosition: analysis.averagePosition,
        strengthAreas: analysis.strengthAreas,
        contentStrategy: analysis.contentStrategy as any,
      },
    });

    console.log(`✅ Analyzed competitor: ${competitorDomain}`);
    return analysis;
  }

  /**
   * Build dynamic knowledge base from competitor intelligence
   */
  async buildDynamicKnowledgeBase(
    businessId: string,
    realServices: string[],
    competitors: Array<{ domain: string; name: string }>,
    locationCode: number
  ): Promise<void> {
    console.log(`🔍 Building dynamic knowledge base for business ${businessId}...`);

    // Build service taxonomy
    const serviceTaxonomies = await this.buildServiceTaxonomy(businessId, realServices);

    // Analyze all competitors
    const competitorAnalyses: CompetitorAnalysis[] = [];
    for (const competitor of competitors.slice(0, 10)) {
      try {
        const analysis = await this.analyzeCompetitor(
          businessId,
          competitor.domain,
          competitor.name,
          locationCode
        );
        competitorAnalyses.push(analysis);
      } catch (error: any) {
        console.warn(`⚠️ Failed to analyze competitor ${competitor.domain}: ${error.message}`);
      }
    }

    // Build knowledge base structure
    const knowledgeBase = {
      serviceHierarchy: serviceTaxonomies.map((t) => ({
        primary: t.primaryService,
        subServices: t.subServices,
        technologies: t.technologies,
        audiences: t.targetAudiences,
      })),
      competitorInsights: competitorAnalyses.map((c) => ({
        domain: c.competitorDomain,
        name: c.competitorName,
        topKeywords: c.rankingKeywords.slice(0, 20),
        strengthAreas: c.strengthAreas,
        averagePosition: c.averagePosition,
      })),
      contentGaps: this.identifyContentGaps(serviceTaxonomies, competitorAnalyses),
      topicClusters: this.buildTopicClusters(serviceTaxonomies, competitorAnalyses),
      keywordOpportunities: this.identifyKeywordOpportunities(competitorAnalyses),
      contentTypeStrategy: this.determineContentTypeStrategy(serviceTaxonomies, competitorAnalyses),
    };

    // Save to database
    await prisma.dynamicKnowledgeBase.upsert({
      where: { businessId },
      update: {
        serviceHierarchy: knowledgeBase.serviceHierarchy as any,
        competitorInsights: knowledgeBase.competitorInsights as any,
        contentGaps: knowledgeBase.contentGaps as any,
        topicClusters: knowledgeBase.topicClusters as any,
        keywordOpportunities: knowledgeBase.keywordOpportunities as any,
        contentTypeStrategy: knowledgeBase.contentTypeStrategy as any,
        totalCompetitorsAnalyzed: competitorAnalyses.length,
        totalKeywordsDiscovered: competitorAnalyses.reduce(
          (sum, c) => sum + (c.totalKeywords || 0),
          0
        ),
        lastUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        businessId,
        serviceHierarchy: knowledgeBase.serviceHierarchy as any,
        competitorInsights: knowledgeBase.competitorInsights as any,
        contentGaps: knowledgeBase.contentGaps as any,
        topicClusters: knowledgeBase.topicClusters as any,
        keywordOpportunities: knowledgeBase.keywordOpportunities as any,
        contentTypeStrategy: knowledgeBase.contentTypeStrategy as any,
        totalCompetitorsAnalyzed: competitorAnalyses.length,
        totalKeywordsDiscovered: competitorAnalyses.reduce(
          (sum, c) => sum + (c.totalKeywords || 0),
          0
        ),
      },
    });

    console.log(`✅ Dynamic knowledge base built for business ${businessId}`);
  }

  /**
   * Identify content gaps (topics competitors cover that client doesn't)
   */
  private identifyContentGaps(
    serviceTaxonomies: ServiceTaxonomy[],
    competitorAnalyses: CompetitorAnalysis[]
  ): any {
    const clientTopics = new Set(
      serviceTaxonomies.flatMap((t) => [
        t.primaryService,
        ...t.subServices,
      ])
    );

    const competitorTopics = new Set(
      competitorAnalyses.flatMap((c) => c.contentTopics)
    );

    const gaps = Array.from(competitorTopics).filter(
      (topic) => !clientTopics.has(topic.toLowerCase())
    );

    return gaps.slice(0, 20); // Top 20 gaps
  }

  /**
   * Build topic clusters for content strategy
   */
  private buildTopicClusters(
    serviceTaxonomies: ServiceTaxonomy[],
    competitorAnalyses: CompetitorAnalysis[]
  ): any {
    const clusters = serviceTaxonomies.map((taxonomy) => ({
      primaryService: taxonomy.primaryService,
      relatedTopics: [
        ...taxonomy.subServices,
        ...competitorAnalyses
          .flatMap((c) => c.contentTopics)
          .filter((topic) =>
            topic.toLowerCase().includes(taxonomy.primaryService.toLowerCase())
          )
          .slice(0, 10),
      ],
    }));

    return clusters;
  }

  /**
   * Identify high-opportunity keywords from competitor analysis
   */
  private identifyKeywordOpportunities(
    competitorAnalyses: CompetitorAnalysis[]
  ): any {
    const keywordFrequency = new Map<string, number>();

    competitorAnalyses.forEach((analysis) => {
      analysis.rankingKeywords.forEach((keyword) => {
        const count = keywordFrequency.get(keyword) || 0;
        keywordFrequency.set(keyword, count + 1);
      });
    });

    // Sort by frequency (keywords multiple competitors rank for are high opportunity)
    const opportunities = Array.from(keywordFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([keyword, frequency]) => ({
        keyword,
        frequency,
        opportunityScore: frequency * 10, // Higher frequency = higher opportunity
      }));

    return opportunities;
  }

  /**
   * Determine content type mix based on industry and competitors
   * LLM-determined strategy
   */
  private determineContentTypeStrategy(
    serviceTaxonomies: ServiceTaxonomy[],
    competitorAnalyses: CompetitorAnalysis[]
  ): any {
    // TODO: Use LLM to determine optimal content type mix
    // For now, return default distribution
    return {
      blog: 0.4,
      guides: 0.25,
      reviews: 0.15,
      howTo: 0.1,
      caseStudies: 0.05,
      news: 0.05,
    };
  }

  /**
   * Get existing knowledge base for a business
   */
  async getKnowledgeBase(businessId: string) {
    return await prisma.dynamicKnowledgeBase.findUnique({
      where: { businessId },
    });
  }
}

