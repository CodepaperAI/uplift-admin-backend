import axios from "axios";
import type { GuestPostPublisher, GuestPostSubmission } from "@prisma/client";

/**
 * Detect if a guest post has been published on the publisher's website
 */
export async function detectPublishedPost(
  publisher: GuestPostPublisher,
  submission: GuestPostSubmission
): Promise<{
  found: boolean;
  publishedUrl?: string;
  publishedTitle?: string;
  backlinks?: string[];
}> {
  try {
    console.log(`🔍 Checking for published post: ${submission.title} on ${publisher.websiteUrl}`);

    // Strategy 1: Check if publisher has a blog/guest-post section
    // We'll search for the submission title or keywords in the publisher's blog

    const searchTerms = [
      submission.title,
      submission.proposedTopic,
      ...(submission.title.split(" ").slice(0, 5)), // First 5 words of title
    ].filter(Boolean) as string[];

    // Try to find the post by searching the publisher's blog
    const blogUrl = getBlogUrl(publisher.websiteUrl);
    
    if (!blogUrl) {
      console.log(`⚠️ Could not determine blog URL for ${publisher.websiteUrl}`);
      return { found: false };
    }

    // Fetch the blog page
    try {
      const response = await axios.get(blogUrl, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SEO Tool Bot)",
        },
      });

      const html = response.data;

      // Search for the submission title in the HTML
      const titleFound = searchTerms.some((term) => {
        if (!term) return false;
        const normalizedTerm = term.toLowerCase().trim();
        const normalizedHtml = html.toLowerCase();
        return normalizedHtml.includes(normalizedTerm);
      });

      if (!titleFound) {
        return { found: false };
      }

      // Try to extract the published URL
      // Look for links containing the title or keywords
      const urlMatch = extractPostUrl(html, submission.title, blogUrl);

      if (urlMatch) {
        // Extract backlinks from the published post
        // Note: We need the target domain (user's business website) for backlink extraction
        // For now, we'll just return the URL - backlinks can be extracted separately
        // when we have the business website URL

        return {
          found: true,
          publishedUrl: urlMatch,
          publishedTitle: submission.title,
          backlinks: [], // Will be extracted separately with business domain
        };
      }

      // If we found the title but couldn't extract URL, return found but no URL
      return {
        found: true,
        publishedTitle: submission.title,
      };
    } catch (error: any) {
      console.error(`Error fetching blog page:`, error.message);
      return { found: false };
    }
  } catch (error: any) {
    console.error(`Error detecting published post:`, error);
    return { found: false };
  }
}

/**
 * Get blog URL from publisher website
 */
function getBlogUrl(websiteUrl: string): string | null {
  try {
    const url = new URL(websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`);
    
    // Common blog URL patterns
    const blogPaths = [
      "/blog",
      "/articles",
      "/guest-posts",
      "/guest-posting",
      "/write-for-us",
      "/contributors",
    ];

    // Try the main domain first
    for (const path of blogPaths) {
      const blogUrl = `${url.origin}${path}`;
      // In a real implementation, we'd check if this URL exists
      // For now, return the first common path
      return blogUrl;
    }

    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Extract post URL from HTML content
 */
function extractPostUrl(
  html: string,
  title: string,
  baseUrl: string
): string | null {
  try {
    // Look for anchor tags containing the title
    const titleWords = title.split(" ").slice(0, 3); // First 3 words
    const titlePattern = titleWords.join(".*?");

    // Match <a> tags with href containing blog/article patterns
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>.*?<\/a>/gi;
    const matches = html.match(linkRegex) || [];

    for (const match of matches) {
      const hrefMatch = match.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;

      const href = hrefMatch[1];
      if (!href) continue;
      const fullUrl = href.startsWith("http") ? href : new URL(href, baseUrl).href;

      if (
        /\/blog\/|\/article\/|\/post\/|\/guest/i.test(fullUrl) &&
        titleWords.some((word) => fullUrl.toLowerCase().includes(word.toLowerCase()))
      ) {
        return fullUrl;
      }
    }

    return null;
  } catch {
    return null;
  }
}


