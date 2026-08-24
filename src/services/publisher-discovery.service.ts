import { prisma } from "../config/db.config";
import { fetchDomainRankFromDataForSEO } from "../utils/dataforseo-backlinks.utils";
import { discoverFromReddit } from "../utils/reddit-scraper.utils";
import { discoverFromMedium } from "../utils/medium-scraper.utils";
import { analyzePublisherWithAI } from "../utils/ai-publisher-analysis.utils";
import {
  isSourceAvailabilityError,
  type SourceAvailabilityError,
} from "../utils/source-availability.errors";

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    // First try to clean the URL if it's malformed
    const cleanedUrl = cleanAndValidateUrl(url);
    if (cleanedUrl) {
      const urlObj = new URL(cleanedUrl);
      const hostname = urlObj.hostname.replace("www.", "");
      // Validate hostname has TLD
      if (hostname.includes('.') && (hostname.split('.').pop() ?? "").length >= 2) {
        return hostname;
      }
    }
    
    // Fallback: try to parse as-is
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    return urlObj.hostname.replace("www.", "");
  } catch (error) {
    // Last resort: manual extraction
    const cleaned = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const first = cleaned.split("/")[0];
    const domain = (first ?? cleaned).split("?")[0]?.split("#")[0] ?? first ?? cleaned;
    
    if (domain && domain.includes('.') && (domain.split('.').pop() ?? "").length >= 2) {
      return domain;
    }
    
    // Return as-is if we can't extract properly
    return domain || url;
  }
}

/**
 * Clean and validate URL
 * Removes markdown syntax, trailing characters, and validates URLs
 */
function cleanAndValidateUrl(url: string): string | null {
  try {
    // Remove markdown link syntax: [text](url) -> url
    let cleaned = url.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
    
    // Remove leading/trailing whitespace first
    cleaned = cleaned.trim();
    
    // Remove markdown brackets
    cleaned = cleaned.replace(/^\[|\]$/g, '');
    
    // Remove trailing markdown characters: ), ], }, ,, ., ;, :
    // But be careful not to remove valid URL parts
    cleaned = cleaned.replace(/[)\]},.;:]+$/, '');
    
    // Validate it's a proper URL
    if (!cleaned.match(/^https?:\/\//)) {
      // Try to add http:// if missing
      // Check if it looks like a domain (has TLD)
      if (cleaned.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)) {
        cleaned = `http://${cleaned}`;
      } else {
        return null; // Invalid URL - no TLD detected
      }
    }
    
    // Try to parse as URL to validate
    const urlObj = new URL(cleaned);
    
    // Validate the hostname has a TLD (at least one dot after removing www)
    const hostname = urlObj.hostname.replace(/^www\./, '');
    if (!hostname.includes('.') || hostname.split('.').pop()!.length < 2) {
      return null; // Invalid - no valid TLD
    }
    
    return urlObj.href;
  } catch (error) {
    // Invalid URL, return null
    return null;
  }
}

export interface DiscoveredPublisher {
  websiteUrl: string;
  name: string;
  domain: string;
  niche?: string;
  contactEmail?: string;
  contactName?: string;
  submissionGuidelines?: string;
  domainAuthority?: number;
  domainRank?: number;
  source: string;
  discoveryMetadata?: any;
  aiConfidenceScore?: number;
  aiExtractedGuidelines?: string;
}

export type PublisherDiscoverySource = "reddit" | "medium" | "competitors";

export interface PublisherDiscoverySourceStatus {
  source: PublisherDiscoverySource;
  status: "success" | "unavailable" | "error" | "skipped";
  discoveredCount: number;
  message?: string;
}

export interface PublisherDiscoveryResult {
  publishers: DiscoveredPublisher[];
  sourceStatuses: PublisherDiscoverySourceStatus[];
  warnings: string[];
}

function buildSourceWarning(
  source: PublisherDiscoverySource,
  error: unknown
): { status: PublisherDiscoverySourceStatus; warning: string } {
  const sourceLabel =
    source === "reddit"
      ? "Reddit"
      : source === "medium"
        ? "Medium"
        : "Competitor analysis";

  if (isSourceAvailabilityError(error)) {
    return {
      status: {
        source,
        status: "unavailable",
        discoveredCount: 0,
        message: error.userMessage,
      },
      warning: error.userMessage,
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : `${sourceLabel} discovery failed unexpectedly`;

  return {
    status: {
      source,
      status: "error",
      discoveredCount: 0,
      message,
    },
    warning: `${sourceLabel} discovery failed for this run. ${message}`,
  };
}

/**
 * Service for discovering guest posting publishers from various sources
 */
export class PublisherDiscoveryService {
  /**
   * Discover publishers from Reddit
   */
  async discoverFromReddit(
    keywords: string[],
    niche?: string,
    limit: number = 20
  ): Promise<DiscoveredPublisher[]> {
    try {
      console.log(`🔍 Discovering publishers from Reddit with keywords: ${keywords.join(", ")}`);
      
      const results = await discoverFromReddit(keywords, niche, limit);
      
      // Enrich with metrics and AI analysis
      const enriched = await Promise.all(
        results.map(async (publisher) => {
          try {
            // Validate and clean URL before processing
            const cleanedUrl = cleanAndValidateUrl(publisher.websiteUrl);
            if (!cleanedUrl) {
              console.warn(`⚠️ Skipping publisher with invalid URL: ${publisher.websiteUrl}`);
              return null; // Skip invalid URLs
            }
            
            // Update publisher with cleaned URL
            publisher.websiteUrl = cleanedUrl;
            publisher.domain = extractDomain(cleanedUrl);
            
            // Get domain metrics
            const domainRank = await fetchDomainRankFromDataForSEO(publisher.domain);
            const p = publisher as DiscoveredPublisher;
            if (domainRank?.domain_rank) {
              p.domainRank = domainRank.domain_rank;
              p.domainAuthority = Math.round(domainRank.domain_rank / 10);
            }

            const aiAnalysis = await analyzePublisherWithAI(cleanedUrl);
            if (aiAnalysis) {
              p.aiConfidenceScore = aiAnalysis.confidenceScore;
              p.aiExtractedGuidelines = aiAnalysis.guidelines;
              if (aiAnalysis.contactEmail) p.contactEmail = aiAnalysis.contactEmail;
              if (aiAnalysis.contactName) p.contactName = aiAnalysis.contactName;
            }

            return p;
          } catch (error) {
            console.error(`Error enriching publisher ${publisher.websiteUrl}:`, error);
            return null;
          }
        })
      );

      return enriched.filter((p) => p !== null) as DiscoveredPublisher[];
    } catch (error: any) {
      console.error("Error discovering from Reddit:", error);
      if (isSourceAvailabilityError(error)) {
        throw error;
      }
      throw new Error(`Failed to discover publishers from Reddit: ${error.message}`);
    }
  }

  /**
   * Discover publishers from Medium
   */
  async discoverFromMedium(
    keywords: string[],
    niche?: string,
    limit: number = 20
  ): Promise<DiscoveredPublisher[]> {
    try {
      console.log(`🔍 Discovering publishers from Medium with keywords: ${keywords.join(", ")}`);
      
      const results = await discoverFromMedium(keywords, niche, limit);
      
      // Enrich with metrics and AI analysis
      const enriched = await Promise.all(
        results.map(async (publisher) => {
          try {
            // Validate and clean URL before processing
            const cleanedUrl = cleanAndValidateUrl(publisher.websiteUrl);
            if (!cleanedUrl) {
              console.warn(`⚠️ Skipping publisher with invalid URL: ${publisher.websiteUrl}`);
              return null; // Skip invalid URLs
            }
            
            // Update publisher with cleaned URL
            publisher.websiteUrl = cleanedUrl;
            publisher.domain = extractDomain(cleanedUrl);
            
            // Get domain metrics
            const domainRank = await fetchDomainRankFromDataForSEO(publisher.domain);
            const p = publisher as DiscoveredPublisher;
            if (domainRank?.domain_rank) {
              p.domainRank = domainRank.domain_rank;
              p.domainAuthority = Math.round(domainRank.domain_rank / 10);
            }

            const aiAnalysis = await analyzePublisherWithAI(cleanedUrl);
            if (aiAnalysis) {
              p.aiConfidenceScore = aiAnalysis.confidenceScore;
              p.aiExtractedGuidelines = aiAnalysis.guidelines;
              if (aiAnalysis.contactEmail) p.contactEmail = aiAnalysis.contactEmail;
              if (aiAnalysis.contactName) p.contactName = aiAnalysis.contactName;
            }

            return p;
          } catch (error) {
            console.error(`Error enriching publisher ${publisher.websiteUrl}:`, error);
            return null;
          }
        })
      );

      return enriched.filter((p) => p !== null) as DiscoveredPublisher[];
    } catch (error: any) {
      console.error("Error discovering from Medium:", error);
      if (isSourceAvailabilityError(error)) {
        throw error;
      }
      throw new Error(`Failed to discover publishers from Medium: ${error.message}`);
    }
  }

  /**
   * Discover publishers from competitor analysis
   * Finds sites that link to competitors (potential guest posting opportunities)
   */
  async discoverFromCompetitors(
    competitorDomains: string[],
    _userId?: string,
    limit: number = 20
  ): Promise<DiscoveredPublisher[]> {
    try {
      console.log(`🔍 Discovering publishers from competitors: ${competitorDomains.join(", ")}`);
      
      const { fetchBacklinksFromDataForSEO } = await import(
        "../utils/dataforseo-backlinks.utils"
      );
      
      const discoveredMap = new Map<string, DiscoveredPublisher>();
      let availabilityError: SourceAvailabilityError | null = null;
      
      // Get backlinks for each competitor (limit to first 3 to avoid rate limits)
      for (const competitorDomain of competitorDomains.slice(0, 3)) {
        try {
          console.log(`🔗 Fetching backlinks for competitor: ${competitorDomain}`);
          
          // Get backlinks from DataForSEO
          const backlinks = await fetchBacklinksFromDataForSEO(
            competitorDomain,
            200, // Get top 200 backlinks per competitor
            {
              domain_from_rank: 20, // Only domains with DA >= 20
              dofollow: true, // Only dofollow links (more likely to be guest posts)
            }
          );
          
          console.log(`✅ Found ${backlinks.length} backlinks for ${competitorDomain}`);
          
          // Extract unique referring domains
          const referringDomains = new Set<string>();
          for (const backlink of backlinks) {
            if (backlink.domain_from && backlink.url_from) {
              // Extract base domain
              const domain = extractDomain(backlink.domain_from);
              if (domain && !domain.includes(competitorDomain.replace(/^https?:\/\//, "").replace(/^www\./, ""))) {
                referringDomains.add(domain);
              }
            }
          }
          
          console.log(`📊 Found ${referringDomains.size} unique referring domains`);
          
          // Analyze each referring domain with AI to see if it accepts guest posts
          for (const domain of Array.from(referringDomains).slice(0, 10)) {
            // Limit to 10 per competitor to avoid too many API calls
            try {
              // Validate domain has TLD before constructing URL
              if (!domain || !domain.includes('.') || domain.split('.').pop()!.length < 2) {
                console.warn(`⚠️ Skipping invalid domain: ${domain}`);
                continue;
              }
              
              const rawUrl = domain.startsWith("http") ? domain : `https://${domain}`;
              
              // Validate and clean URL before processing
              const websiteUrl = cleanAndValidateUrl(rawUrl);
              if (!websiteUrl) {
                console.warn(`⚠️ Skipping invalid URL: ${rawUrl}`);
                continue;
              }
              
              // Analyze with AI
              const aiAnalysis = await analyzePublisherWithAI(websiteUrl);
              
              if (aiAnalysis && aiAnalysis.confidenceScore >= 0.5) {
                // Get domain metrics
                const domainRank = await fetchDomainRankFromDataForSEO(domain);
                
                const publisher: DiscoveredPublisher = {
                  websiteUrl,
                  name: aiAnalysis.siteName || domain,
                  domain,
                  niche: aiAnalysis.niche,
                  contactEmail: aiAnalysis.contactEmail,
                  contactName: aiAnalysis.contactName,
                  submissionGuidelines: aiAnalysis.guidelines,
                  domainAuthority: domainRank?.domain_rank ? Math.round(domainRank.domain_rank / 10) : undefined,
                  domainRank: domainRank?.domain_rank,
                  source: "COMPETITOR_ANALYSIS",
                  aiConfidenceScore: aiAnalysis.confidenceScore,
                  aiExtractedGuidelines: aiAnalysis.guidelines,
                  discoveryMetadata: {
                    competitorDomain,
                    discoveredAt: new Date().toISOString(),
                    backlinkUrl: backlinks.find(b => b.domain_from === domain)?.url_from,
                  },
                };
                
                // Only add if not already discovered
                if (!discoveredMap.has(domain)) {
                  discoveredMap.set(domain, publisher);
                }
                
                // Stop if we have enough
                if (discoveredMap.size >= limit) {
                  break;
                }
              }
              
              // Add delay to respect rate limits
              await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch (error: any) {
              console.error(`Error analyzing domain ${domain}:`, error.message);
              continue;
            }
          }
          
          // Add delay between competitors
          await new Promise((resolve) => setTimeout(resolve, 2000));
          
          if (discoveredMap.size >= limit) {
            break;
          }
        } catch (error: any) {
          if (isSourceAvailabilityError(error) && !availabilityError) {
            availabilityError = error;
          }
          console.error(`Error processing competitor ${competitorDomain}:`, error.message);
          continue;
        }
      }
      
      const discovered = Array.from(discoveredMap.values());

      if (discovered.length === 0 && availabilityError) {
        throw availabilityError;
      }

      console.log(`✅ Discovered ${discovered.length} publishers from competitor analysis`);
      
      return discovered.slice(0, limit);
    } catch (error: any) {
      console.error("Error discovering from competitors:", error);
      if (isSourceAvailabilityError(error)) {
        throw error;
      }
      throw new Error(`Failed to discover publishers from competitors: ${error.message}`);
    }
  }

  /**
   * Multi-source discovery
   */
  async discoverPublishers(
    sources: string[],
    keywords: string[],
    niche?: string,
    filters?: {
      minDomainAuthority?: number;
      maxDomainAuthority?: number;
      minAIConfidence?: number;
    },
    limit: number = 20,
    competitorDomains?: string[]
  ): Promise<PublisherDiscoveryResult> {
    const allPublishers: DiscoveredPublisher[] = [];
    const sourceStatuses: PublisherDiscoverySourceStatus[] = [];
    const warnings: string[] = [];
    const perSourceLimit = Math.ceil(limit / sources.length);

    try {
      // Discover from each source
      if (sources.includes("reddit")) {
        try {
          const redditPublishers = await this.discoverFromReddit(
            keywords,
            niche,
            perSourceLimit
          );
          allPublishers.push(...redditPublishers);
          sourceStatuses.push({
            source: "reddit",
            status: "success",
            discoveredCount: redditPublishers.length,
          });
        } catch (error) {
          const { status, warning } = buildSourceWarning("reddit", error);
          sourceStatuses.push(status);
          warnings.push(warning);
        }
      }

      if (sources.includes("medium")) {
        try {
          const mediumPublishers = await this.discoverFromMedium(
            keywords,
            niche,
            perSourceLimit
          );
          allPublishers.push(...mediumPublishers);
          sourceStatuses.push({
            source: "medium",
            status: "success",
            discoveredCount: mediumPublishers.length,
          });
        } catch (error) {
          const { status, warning } = buildSourceWarning("medium", error);
          sourceStatuses.push(status);
          warnings.push(warning);
        }
      }

      if (sources.includes("competitors")) {
        if (!competitorDomains || competitorDomains.length === 0) {
          const message =
            "Competitor analysis was requested, but no competitor domains are configured for this business yet.";
          sourceStatuses.push({
            source: "competitors",
            status: "skipped",
            discoveredCount: 0,
            message,
          });
          warnings.push(message);
        } else {
          try {
            const competitorPublishers = await this.discoverFromCompetitors(
              competitorDomains,
              undefined,
              perSourceLimit
            );
            allPublishers.push(...competitorPublishers);
            sourceStatuses.push({
              source: "competitors",
              status: "success",
              discoveredCount: competitorPublishers.length,
            });
          } catch (error) {
            const { status, warning } = buildSourceWarning("competitors", error);
            sourceStatuses.push(status);
            warnings.push(warning);
          }
        }
      }

      // Remove duplicates by domain
      const uniquePublishers = new Map<string, DiscoveredPublisher>();
      for (const publisher of allPublishers) {
        if (!uniquePublishers.has(publisher.domain)) {
          uniquePublishers.set(publisher.domain, publisher);
        }
      }

      let filtered = Array.from(uniquePublishers.values());

      // Apply filters
      if (filters?.minDomainAuthority) {
        filtered = filtered.filter(
          (p) => (p.domainAuthority || 0) >= filters.minDomainAuthority!
        );
      }

      if (filters?.maxDomainAuthority) {
        filtered = filtered.filter(
          (p) => (p.domainAuthority || 100) <= filters.maxDomainAuthority!
        );
      }

      if (filters?.minAIConfidence) {
        filtered = filtered.filter(
          (p) => (p.aiConfidenceScore || 0) >= filters.minAIConfidence!
        );
      }

      // Sort by AI confidence score (highest first)
      filtered.sort((a, b) => (b.aiConfidenceScore || 0) - (a.aiConfidenceScore || 0));

      return {
        publishers: filtered.slice(0, limit),
        sourceStatuses,
        warnings,
      };
    } catch (error: any) {
      console.error("Error in multi-source discovery:", error);
      throw new Error(`Failed to discover publishers: ${error.message}`);
    }
  }

  /**
   * Bulk create discovered publishers
   * @param markAsSuggested - Whether to mark newly created publishers as suggested (for auto-discovery)
   */
  async bulkCreatePublishers(
    userId: string,
    publishers: DiscoveredPublisher[],
    markAsSuggested: boolean = false
  ): Promise<{ created: number; skipped: number; errors: number }> {
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const publisher of publishers) {
      try {
        // Check if publisher already exists
        const existing = await prisma.guestPostPublisher.findUnique({
          where: {
            userId_websiteUrl: {
              userId,
              websiteUrl: publisher.websiteUrl,
            },
          },
        });

        if (existing) {
          skipped++;
          continue;
        }

        // Create publisher
        await prisma.guestPostPublisher.create({
          data: {
            userId,
            name: publisher.name,
            websiteUrl: publisher.websiteUrl,
            domain: publisher.domain,
            niche: publisher.niche || null,
            contactEmail: publisher.contactEmail || null,
            contactName: publisher.contactName || null,
            submissionGuidelines: publisher.aiExtractedGuidelines || publisher.submissionGuidelines || null,
            domainAuthority: publisher.domainAuthority || null,
            domainRank: publisher.domainRank || null,
            source: publisher.source,
            discoveryMetadata: publisher.discoveryMetadata || null,
            aiConfidenceScore: publisher.aiConfidenceScore || null,
            aiExtractedGuidelines: publisher.aiExtractedGuidelines || null,
            lastDiscoveredAt: new Date(),
            isVerified: false,
            verificationMethod: publisher.aiConfidenceScore ? "AI" : "SCRAPED",
            // 🆕 NEW: Mark as suggested only if requested (for auto-discovery)
            isSuggested: markAsSuggested,
            suggestedAt: markAsSuggested ? new Date() : null,
          },
        });

        created++;
      } catch (error: any) {
        console.error(`Error creating publisher ${publisher.websiteUrl}:`, error);
        errors++;
      }
    }

    return { created, skipped, errors };
  }

  /**
   * Analyze a single publisher URL with AI
   */
  async analyzePublisherUrl(url: string): Promise<DiscoveredPublisher | null> {
    try {
      // Validate and clean URL first
      const cleanedUrl = cleanAndValidateUrl(url);
      if (!cleanedUrl) {
        console.warn(`⚠️ Invalid URL provided: ${url}`);
        return null;
      }
      
      const domain = extractDomain(cleanedUrl);
      
      // Get domain metrics
      const domainRank = await fetchDomainRankFromDataForSEO(domain);
      
      // AI analysis
      const aiAnalysis = await analyzePublisherWithAI(cleanedUrl);
      
      if (!aiAnalysis || aiAnalysis.confidenceScore < 0.3) {
        return null; // Low confidence, skip
      }

      return {
        websiteUrl: cleanedUrl,
        name: aiAnalysis.siteName || domain,
        domain,
        niche: aiAnalysis.niche,
        contactEmail: aiAnalysis.contactEmail,
        contactName: aiAnalysis.contactName,
        submissionGuidelines: aiAnalysis.guidelines,
        domainAuthority: domainRank?.domain_rank ? Math.round(domainRank.domain_rank / 10) : undefined,
        domainRank: domainRank?.domain_rank,
        source: "AI_DISCOVERED",
        aiConfidenceScore: aiAnalysis.confidenceScore,
        aiExtractedGuidelines: aiAnalysis.guidelines,
        discoveryMetadata: {
          analyzedAt: new Date().toISOString(),
          aiModel: "openai",
        },
      };
    } catch (error: any) {
      console.error(`Error analyzing publisher URL ${url}:`, error);
      return null;
    }
  }
}
