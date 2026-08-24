import axios from "axios";
import type { PublishResult, BlogPublishData } from "../types/publishing.types";
import { decryptOAuthToken } from "./oauth-token-crypto";

interface RedditCredentials {
  accessToken: string;
  subreddit?: string;
  userAgent?: string;
}

export async function publishToReddit(
  blog: BlogPublishData,
  credentials: RedditCredentials
): Promise<PublishResult> {
  try {
    const decryptedToken = decryptOAuthToken(credentials.accessToken, "reddit");
    const userAgent = credentials.userAgent || process.env.REDDIT_USER_AGENT || "SEO-Tool/1.0";
    const subreddit = credentials.subreddit || "self"; // Default to user's profile if no subreddit

    const title = blog.title;
    const content = blog.content;

    // Convert HTML to plain text for Reddit (Reddit uses markdown)
    const textContent = convertHtmlToMarkdown(content);

    // Reddit API endpoint for submitting a post
    const url = subreddit === "self" 
      ? "https://oauth.reddit.com/api/submit"
      : `https://oauth.reddit.com/r/${subreddit}/api/submit`;

    const postData = new URLSearchParams({
      kind: "self", // "self" for text posts, "link" for links
      title: title,
      text: textContent.substring(0, 40000), // Reddit has a 40k character limit
      sr: subreddit === "self" ? "" : subreddit,
    });

    console.log(`[Reddit] Publishing to ${subreddit === "self" ? "user profile" : `r/${subreddit}`}...`);

    const response = await axios.post(url, postData, {
      headers: {
        Authorization: `bearer ${decryptedToken}`,
        "User-Agent": userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 30000,
    });

    if (response.data?.json?.errors && response.data.json.errors.length > 0) {
      const error = response.data.json.errors[0];
      throw new Error(error.join(": ") || "Reddit API error");
    }

    const postId = response.data?.json?.data?.id;
    const postName = response.data?.json?.data?.name;

    if (!postId && !postName) {
      throw new Error("Failed to get post ID from Reddit response");
    }

    const postUrl = postName 
      ? `https://www.reddit.com${postName}`
      : `https://www.reddit.com/r/${subreddit}/comments/${postId}`;

    console.log(`[Reddit] ✅ Post created! URL: ${postUrl}`);

    return {
      success: true,
      postId: postId || postName || "",
      postUrl: postUrl,
      status: "published",
      platformResponse: response.data,
    };
  } catch (error: any) {
    console.error("[Reddit] ❌ Error creating post:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.response?.data || error.message);

    const errorMessage = error.response?.data?.json?.errors?.[0]?.join(": ") ||
      error.response?.data?.message ||
      error.message ||
      "Failed to create Reddit post";

    throw new Error(errorMessage);
  }
}

export async function testRedditConnection(
  credentials: RedditCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const decryptedToken = decryptOAuthToken(credentials.accessToken, "reddit");
    const userAgent = credentials.userAgent || process.env.REDDIT_USER_AGENT || "SEO-Tool/1.0";

    const response = await axios.get("https://oauth.reddit.com/api/v1/me", {
      headers: {
        Authorization: `bearer ${decryptedToken}`,
        "User-Agent": userAgent,
      },
      timeout: 10000,
    });

    if (response.status === 200 && response.data?.name) {
      return { success: true };
    }

    return {
      success: false,
      error: "Invalid response from Reddit",
    };
  } catch (error: any) {
    return {
      success: false,
      error:
        error.response?.data?.message ||
        error.message ||
        "Failed to connect to Reddit",
    };
  }
}

function convertHtmlToMarkdown(html: string): string {
  let markdown = html;

  markdown = markdown.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  markdown = markdown.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  markdown = markdown.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");
  markdown = markdown.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n");
  markdown = markdown.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  markdown = markdown.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  markdown = markdown.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  markdown = markdown.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
  markdown = markdown.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  markdown = markdown.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
  markdown = markdown.replace(/<br[^>]*>/gi, "\n");
  markdown = markdown.replace(/<ul[^>]*>(.*?)<\/ul>/gi, "$1");
  markdown = markdown.replace(/<ol[^>]*>(.*?)<\/ol>/gi, "$1");
  markdown = markdown.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
  markdown = markdown.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
  markdown = markdown.replace(/<pre[^>]*>(.*?)<\/pre>/gi, "```\n$1\n```");
  markdown = markdown.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, "> $1");
  markdown = markdown.replace(/<[^>]+>/g, "");
  markdown = markdown.replace(/&nbsp;/g, " ");
  markdown = markdown.replace(/&amp;/g, "&");
  markdown = markdown.replace(/&lt;/g, "<");
  markdown = markdown.replace(/&gt;/g, ">");
  markdown = markdown.replace(/&quot;/g, '"');
  markdown = markdown.replace(/&#39;/g, "'");

  return markdown.trim();
}
