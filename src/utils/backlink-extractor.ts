import axios from "axios";

/**
 * Extract backlinks from a published guest post
 * This is a more comprehensive version that can be used independently
 */
export async function extractBacklinks(
  publishedUrl: string,
  targetDomain: string
): Promise<{
  backlinks: string[];
  dofollowCount: number;
  nofollowCount: number;
  totalLinks: number;
}> {
  try {
    console.log(`🔗 Extracting backlinks from ${publishedUrl}`);

    const response = await axios.get(publishedUrl, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SEO Tool Bot)",
      },
    });

    const html = response.data;
    const backlinks: string[] = [];
    let dofollowCount = 0;
    let nofollowCount = 0;

    // Extract domain from target domain
    const targetDomainClean = targetDomain
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    // Find all links in the post
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
    const matches = html.match(linkRegex) || [];

    for (const match of matches) {
      const hrefMatch = match.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;

      const href = hrefMatch[1];
      
      // Skip mailto, tel, and anchor links
      if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) {
        continue;
      }

      const fullUrl = href.startsWith("http") ? href : new URL(href, publishedUrl).href;

      // Check if link points to target domain
      if (fullUrl.includes(targetDomainClean)) {
        // Check if it's dofollow or nofollow
        const isNofollow = match.includes('rel="nofollow"') || match.includes("rel='nofollow'");
        
        if (isNofollow) {
          nofollowCount++;
        } else {
          dofollowCount++;
          backlinks.push(fullUrl);
        }
      }
    }

    const uniqueBacklinks = [...new Set(backlinks)];

    console.log(`✅ Extracted ${uniqueBacklinks.length} backlinks (${dofollowCount} dofollow, ${nofollowCount} nofollow)`);

    return {
      backlinks: uniqueBacklinks,
      dofollowCount: dofollowCount,
      nofollowCount: nofollowCount,
      totalLinks: dofollowCount + nofollowCount,
    };
  } catch (error: any) {
    console.error(`❌ Error extracting backlinks from ${publishedUrl}:`, error);
    return {
      backlinks: [],
      dofollowCount: 0,
      nofollowCount: 0,
      totalLinks: 0,
    };
  }
}

/**
 * Verify if a backlink is live and accessible
 */
export async function verifyBacklink(backlinkUrl: string): Promise<boolean> {
  try {
    const response = await axios.head(backlinkUrl, {
      timeout: 5000,
      validateStatus: (status) => status < 500, // Accept 2xx, 3xx, 4xx
    });

    return response.status < 400; // 2xx or 3xx is considered live
  } catch {
    return false;
  }
}

