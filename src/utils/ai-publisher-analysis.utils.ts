import axios from "axios";
import OpenAI from "openai";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface AIPublisherAnalysis {
  acceptsGuestPosts: boolean;
  confidenceScore: number; // 0-1
  siteName?: string;
  niche?: string;
  guidelines?: string;
  contactEmail?: string;
  contactName?: string;
  minWordCount?: number;
  maxWordCount?: number;
  requiresPayment?: boolean;
  acceptsLinks?: boolean;
}

/**
 * Clean and validate URL before fetching
 */
function cleanAndValidateUrl(url: string): string | null {
  try {
    // Remove markdown link syntax: [text](url) -> url
    let cleaned = url.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$2");

    // Remove leading/trailing whitespace first
    cleaned = cleaned.trim();

    // Remove markdown brackets
    cleaned = cleaned.replace(/^\[|\]$/g, "");

    // Remove trailing markdown characters: ), ], }, ,, ., ;, :
    // But be careful not to remove valid URL parts
    cleaned = cleaned.replace(/[)\]},.;:]+$/, "");

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

    // Clean the pathname - remove trailing colons, semicolons, and other invalid characters
    if (urlObj.pathname) {
      urlObj.pathname = urlObj.pathname.replace(/[)\]},.;:]+$/, "");
    }

    // Validate the hostname has a TLD (at least one dot after removing www)
    const hostname = urlObj.hostname.replace(/^www\./, "");
    if (!hostname.includes(".") || hostname.split(".").pop()!.length < 2) {
      return null; // Invalid - no valid TLD
    }

    return urlObj.href;
  } catch (error) {
    // Invalid URL, return null
    return null;
  }
}

/**
 * Fetch website content for analysis
 */
async function fetchWebsiteContent(url: string): Promise<string> {
  try {
    // Validate and clean URL first
    const cleanedUrl = cleanAndValidateUrl(url);
    if (!cleanedUrl) {
      throw new Error(`Invalid URL: ${url}`);
    }

    const response = await axios.get(cleanedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    // Extract text content from HTML (simplified)
    const html = response.data;
    // Remove script and style tags
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.substring(0, 10000); // Limit to first 10k chars
  } catch (error: any) {
    console.error(`Error fetching website content for ${url}:`, error.message);
    return "";
  }
}

/**
 * Analyze publisher website with AI to determine if it accepts guest posts
 */
export async function analyzePublisherWithAI(
  websiteUrl: string
): Promise<AIPublisherAnalysis | null> {
  try {
    // Fetch website content
    const content = await fetchWebsiteContent(websiteUrl);

    if (!content || content.length < 100) {
      // Not enough content to analyze
      return null;
    }

    // Use OpenAI to analyze
    const prompt = `Analyze this website content and determine if it accepts guest posts. Extract the following information:

Website URL: ${websiteUrl}
Website Content (first 10k chars): ${content.substring(0, 10000)}

Please provide a JSON response with:
1. acceptsGuestPosts: boolean - Does this website accept guest posts?
2. confidenceScore: number (0-1) - How confident are you?
3. siteName: string - Name of the website/publication
4. niche: string - What niche/industry is this site about?
5. guidelines: string - Submission guidelines if mentioned
6. contactEmail: string - Contact email if found
7. contactName: string - Contact person name if found
8. minWordCount: number - Minimum word count if mentioned
9. maxWordCount: number - Maximum word count if mentioned
10. requiresPayment: boolean - Does it require payment?
11. acceptsLinks: boolean - Does it accept backlinks?

Look for keywords like: "write for us", "guest post", "submit article", "contribute", "guest blogger", "accepting submissions", "submission guidelines"

Return ONLY valid JSON, no other text.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Using cheaper model for cost efficiency
      messages: [
        {
          role: "system",
          content:
            "You are an expert at analyzing websites to determine if they accept guest posts. Always return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],

      max_tokens: 1000,
    });

    const responseText = completion.choices[0]?.message?.content || "{}";

    // Parse JSON response
    let analysis: AIPublisherAnalysis;
    try {
      // Clean response - remove markdown code blocks if present
      const cleaned = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      analysis = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("Error parsing AI response:", parseError);
      // Fallback: try to extract basic info
      const lowerContent = content.toLowerCase();
      const hasGuestPostKeywords =
        lowerContent.includes("write for us") ||
        lowerContent.includes("guest post") ||
        lowerContent.includes("submit article") ||
        lowerContent.includes("contribute");

      return {
        acceptsGuestPosts: hasGuestPostKeywords,
        confidenceScore: hasGuestPostKeywords ? 0.5 : 0.2,
      };
    }

    // Validate and return
    if (!analysis.acceptsGuestPosts || (analysis.confidenceScore || 0) < 0.3) {
      return null; // Low confidence or doesn't accept guest posts
    }

    return analysis;
  } catch (error: any) {
    console.error(
      `Error analyzing publisher with AI for ${websiteUrl}:`,
      error
    );

    // Fallback: basic keyword check
    try {
      const content = await fetchWebsiteContent(websiteUrl);
      const lowerContent = content.toLowerCase();
      const hasGuestPostKeywords =
        lowerContent.includes("write for us") ||
        lowerContent.includes("guest post") ||
        lowerContent.includes("submit article");

      if (hasGuestPostKeywords) {
        return {
          acceptsGuestPosts: true,
          confidenceScore: 0.4, // Lower confidence for fallback
        };
      }
    } catch (fallbackError) {
      // Ignore fallback errors
    }

    return null;
  }
}

/**
 * Extract contact information from website using AI
 */
export async function extractContactInfo(websiteUrl: string): Promise<{
  email?: string;
  name?: string;
}> {
  try {
    const content = await fetchWebsiteContent(websiteUrl);

    if (!content) {
      return {};
    }

    const prompt = `Extract contact information from this website content:

${content.substring(0, 5000)}

Find:
1. Contact email address
2. Contact person name (editor, content manager, etc.)

Return JSON: {"email": "string or null", "name": "string or null"}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract contact information from website content. Return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],

      max_tokens: 200,
    });

    const responseText = completion.choices[0]?.message?.content || "{}";
    const cleaned = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const result = JSON.parse(cleaned);

    return {
      email: result.email || undefined,
      name: result.name || undefined,
    };
  } catch (error: any) {
    console.error(`Error extracting contact info from ${websiteUrl}:`, error);
    return {};
  }
}
