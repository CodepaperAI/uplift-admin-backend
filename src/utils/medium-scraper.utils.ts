import axios from "axios";

export interface MediumPublication {
  name: string;
  url: string;
  description?: string;
  followers?: number;
}

export interface DiscoveredPublisher {
  websiteUrl: string;
  name: string;
  domain: string;
  niche?: string;
  source: string;
  discoveryMetadata: {
    mediumPublication?: MediumPublication;
    discoveredAt: string;
  };
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    return urlObj.hostname.replace("www.", "");
  } catch (error) {
    const cleaned = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    return cleaned.split("/")[0] ?? url;
  }
}

/**
 * Discover publishers from Medium
 */
export async function discoverFromMedium(
  keywords: string[],
  niche?: string,
  limit: number = 20
): Promise<DiscoveredPublisher[]> {
  const discovered: DiscoveredPublisher[] = [];
  const seenDomains = new Set<string>();

  try {
    // Medium search API (public, no auth needed)
    // Note: Medium's official API is limited, so we'll use web scraping approach
    
    // Search for publications that accept submissions
    const searchTerms = [
      ...keywords,
      "write for us",
      "guest post",
      "submit article",
      "contribute",
    ];

    for (const term of searchTerms.slice(0, 5)) {
      // Limit to 5 search terms
      try {
        // Medium search URL
        const searchUrl = `https://medium.com/search?q=${encodeURIComponent(
          `${term} write for us`
        )}`;

        // Use axios to fetch (we'll parse HTML or use Medium's RSS/JSON if available)
        // For now, we'll use a simplified approach
        // In production, you'd want to use Puppeteer for proper scraping
        
        // Alternative: Search Medium publications directory
        // Medium doesn't have a public API, so we'll need to scrape or use known publications
        
        // For MVP, we'll return some known Medium publications that accept guest posts
        // In production, implement proper scraping with Puppeteer
        
        const knownMediumPublications = [
          {
            name: "The Startup",
            url: "https://medium.com/swlh",
            domain: "medium.com",
            niche: "Startup",
          },
          {
            name: "The Writing Cooperative",
            url: "https://medium.com/writing-cooperative",
            domain: "medium.com",
            niche: "Writing",
          },
          {
            name: "Better Marketing",
            url: "https://medium.com/better-marketing",
            domain: "medium.com",
            niche: "Marketing",
          },
        ];

        for (const pub of knownMediumPublications) {
          if (seenDomains.has(pub.domain)) continue;
          
          // Check if matches niche/keywords
          const matchesNiche = !niche || pub.niche?.toLowerCase().includes(niche.toLowerCase());
          const matchesKeywords = keywords.some((kw) =>
            pub.name.toLowerCase().includes(kw.toLowerCase()) ||
            pub.niche?.toLowerCase().includes(kw.toLowerCase())
          );

          if (matchesNiche || matchesKeywords) {
            seenDomains.add(pub.domain);
            discovered.push({
              websiteUrl: pub.url,
              name: pub.name,
              domain: pub.domain,
              niche: pub.niche,
              source: "MEDIUM",
              discoveryMetadata: {
                mediumPublication: {
                  name: pub.name,
                  url: pub.url,
                },
                discoveredAt: new Date().toISOString(),
              },
            });

            if (discovered.length >= limit) break;
          }
        }

        if (discovered.length >= limit) break;

        // Rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error: any) {
        console.error(`Error searching Medium for "${term}":`, error.message);
        // Continue to next search
      }
    }

    return discovered.slice(0, limit);
  } catch (error: any) {
    console.error("Error discovering from Medium:", error);
    throw new Error(`Failed to discover from Medium: ${error.message}`);
  }
}

/**
 * Scrape Medium publication page for submission guidelines
 */
export async function scrapeMediumPublication(url: string): Promise<{
  acceptsSubmissions: boolean;
  guidelines?: string;
  contactEmail?: string;
}> {
  try {
    // This would use Puppeteer to scrape the actual Medium publication page
    // For now, return default values
    // In production, implement proper scraping
    
    return {
      acceptsSubmissions: true, // Assume true for Medium publications
      guidelines: "Check publication guidelines on Medium",
    };
  } catch (error: any) {
    console.error(`Error scraping Medium publication ${url}:`, error);
    return {
      acceptsSubmissions: false,
    };
  }
}

