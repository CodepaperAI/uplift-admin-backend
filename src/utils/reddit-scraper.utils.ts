import axios from "axios";
import { SourceAvailabilityError } from "./source-availability.errors";

export interface RedditPost {
  title: string;
  url: string;
  subreddit: string;
  author: string;
  score: number;
  created: number;
  selftext?: string;
  permalink: string;
}

export interface DiscoveredPublisher {
  websiteUrl: string;
  name: string;
  domain: string;
  niche?: string;
  source: string;
  discoveryMetadata: {
    redditPost: RedditPost;
    discoveredAt: string;
  };
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    // First try to clean the URL if it's malformed
    const cleanedUrl = cleanUrl(url);
    if (cleanedUrl) {
      const urlObj = new URL(cleanedUrl);
      return urlObj.hostname.replace("www.", "");
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
 * Clean and normalize URLs extracted from text
 * Removes markdown syntax, trailing characters, and validates URLs
 */
function cleanUrl(url: string): string | null {
  try {
    // Remove markdown link syntax: [text](url) -> url
    let cleaned = url.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
    
    // Remove leading/trailing whitespace first
    cleaned = cleaned.trim();
    
    // Remove any remaining markdown brackets
    cleaned = cleaned.replace(/^\[|\]$/g, '');
    
    // Remove trailing markdown characters: ), ], }, ,, ., ;, :
    // But be careful not to remove valid URL parts
    // Only remove if they're at the very end and not part of the domain
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
    if (!hostname.includes('.') || (hostname.split('.').pop() ?? "").length < 2) {
      return null; // Invalid - no valid TLD
    }
    
    // Return clean URL
    return urlObj.href;
  } catch (error) {
    // Invalid URL, return null
    return null;
  }
}

/**
 * Extract website URLs from Reddit post text (IMPROVED)
 */
function extractUrlsFromText(text: string): string[] {
  // First, extract markdown links: [text](url)
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const markdownLinks: string[] = [];
  let match;
  while ((match = markdownLinkRegex.exec(text)) !== null) {
    const url = match[2] ?? "";
    const cleaned = cleanUrl(url);
    if (cleaned) markdownLinks.push(cleaned);
  }
  
  // Then extract plain URLs
  const urlRegex = /(https?:\/\/[^\s\)\]\},.;:]+)/g;
  const plainUrls: string[] = [];
  const matches = text.match(urlRegex) || [];
  for (const url of matches) {
    const cleaned = cleanUrl(url);
    if (cleaned) plainUrls.push(cleaned);
  }
  
  // Combine and deduplicate
  const allUrls = [...markdownLinks, ...plainUrls];
  const uniqueUrls = [...new Set(allUrls)];
  
  return uniqueUrls.filter((url) => {
    const domain = extractDomain(url);
    // Filter out Reddit URLs and common non-website URLs
    return (
      !domain.includes("reddit.com") &&
      !domain.includes("redd.it") &&
      !domain.includes("imgur.com") &&
      !domain.includes("youtube.com") &&
      !domain.includes("youtu.be")
    );
  });
}

/**
 * Discover publishers from Reddit
 */
export async function discoverFromReddit(
  keywords: string[],
  niche?: string,
  limit: number = 20
): Promise<DiscoveredPublisher[]> {
  const discovered = new Map<string, DiscoveredPublisher>();
  let requestAttempts = 0;
  let forbiddenAttempts = 0;
  let rateLimitedAttempts = 0;

  try {
    // Reddit subreddits to search
    const subreddits = [
      "guestpost",
      "guestblogging",
      "blogging",
      "SEO",
      "marketing",
      "content_marketing",
      "bloggers",
      niche?.toLowerCase(),
    ].filter(Boolean) as string[];

    // Search terms
    const searchTerms = [
      ...keywords,
      "guest post",
      "write for us",
      "accepting submissions",
      "guest blogger",
      "contribute",
    ];

    for (const subreddit of subreddits.slice(0, 3)) {
      // Limit to 3 subreddits to avoid rate limits
      for (const term of searchTerms.slice(0, 3)) {
        // Limit search terms
        try {
          requestAttempts++;
          // Use Reddit JSON API (no auth needed for public data)
          const searchUrl = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(
            term
          )}&sort=relevance&limit=10&restrict_sr=1`;

          const response = await axios.get(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; SEO Tool Bot/1.0)",
            },
            timeout: 10000,
          });

          const posts = response.data?.data?.children || [];

          for (const postData of posts) {
            const post: RedditPost = postData.data;
            const text = `${post.title} ${post.selftext || ""}`.toLowerCase();

            // Check if post is about guest posting
            const guestPostKeywords = [
              "guest post",
              "write for us",
              "accepting submissions",
              "guest blogger",
              "contribute",
              "submit article",
            ];

            const isGuestPostRelated = guestPostKeywords.some((keyword) =>
              text.includes(keyword)
            );

            if (!isGuestPostRelated) continue;

            // Extract URLs from post
            const urls = extractUrlsFromText(`${post.title} ${post.selftext || ""}`);

            for (const url of urls) {
              try {
                // Validate URL is clean before using it
                const cleanedUrl = cleanUrl(url);
                if (!cleanedUrl) {
                  console.warn(`⚠️ Skipping invalid URL: ${url}`);
                  continue;
                }
                
                const domain = extractDomain(cleanedUrl);
                
                // Skip if already found
                if (discovered.has(domain)) continue;

                // Basic validation - domain must have TLD
                if (!domain || domain.length < 3 || !domain.includes('.')) {
                  console.warn(`⚠️ Skipping invalid domain: ${domain}`);
                  continue;
                }
                
                // Validate TLD is at least 2 characters
                const tld = domain.split('.').pop();
                if (!tld || tld.length < 2) {
                  console.warn(`⚠️ Skipping domain with invalid TLD: ${domain}`);
                  continue;
                }

                discovered.set(domain, {
                  websiteUrl: cleanedUrl, // Use cleaned URL
                  name: domain,
                  domain,
                  niche: niche || undefined,
                  source: "REDDIT",
                  discoveryMetadata: {
                    redditPost: {
                      title: post.title,
                      url: `https://reddit.com${post.permalink}`,
                      subreddit: post.subreddit,
                      author: post.author,
                      score: post.score,
                      created: post.created,
                      selftext: post.selftext,
                      permalink: post.permalink,
                    },
                    discoveredAt: new Date().toISOString(),
                  },
                });

                if (discovered.size >= limit) break;
              } catch (error) {
                console.error(`Error processing URL ${url}:`, error);
              }
            }

            if (discovered.size >= limit) break;
          }

          // Rate limiting - be respectful
          await new Promise((resolve) => setTimeout(resolve, 1000));

          if (discovered.size >= limit) break;
        } catch (error: any) {
          const status = error?.response?.status;
          if (status === 403) {
            forbiddenAttempts++;
          }
          if (status === 429) {
            rateLimitedAttempts++;
          }
          console.error(`Error searching Reddit r/${subreddit} for "${term}":`, error.message);
          // Continue to next search
        }
      }

      if (discovered.size >= limit) break;
    }

    if (
      discovered.size === 0 &&
      requestAttempts > 0 &&
      forbiddenAttempts === requestAttempts
    ) {
      throw new SourceAvailabilityError({
        source: "reddit",
        code: "REDDIT_FORBIDDEN",
        message: "Reddit guest-post discovery requests are being blocked (403)",
        userMessage:
          "Reddit blocked guest-post discovery requests right now, so results from Reddit are temporarily unavailable.",
        retryable: true,
        statusCode: 403,
      });
    }

    if (
      discovered.size === 0 &&
      requestAttempts > 0 &&
      rateLimitedAttempts === requestAttempts
    ) {
      throw new SourceAvailabilityError({
        source: "reddit",
        code: "REDDIT_RATE_LIMITED",
        message: "Reddit guest-post discovery requests are rate limited (429)",
        userMessage:
          "Reddit rate limited guest-post discovery requests right now, so results from Reddit are temporarily unavailable.",
        retryable: true,
        statusCode: 429,
      });
    }

    return Array.from(discovered.values()).slice(0, limit);
  } catch (error: any) {
    console.error("Error discovering from Reddit:", error);
    throw new Error(`Failed to discover from Reddit: ${error.message}`);
  }
}
