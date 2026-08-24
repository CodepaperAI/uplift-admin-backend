import axios from "axios";
import type { PublishResult, BlogPublishData } from "../types/publishing.types";
import { decryptOAuthToken } from "./oauth-token-crypto";

interface MediumCredentials {
  accessToken: string;
  publicationId?: string;
}

export async function publishToMedium(
  blog: BlogPublishData,
  credentials: MediumCredentials
): Promise<PublishResult> {
  try {
    const decryptedToken = decryptOAuthToken(credentials.accessToken, "medium");

    // Get user info to get userId
    const userResponse = await axios.get("https://api.medium.com/v1/me", {
      headers: {
        Authorization: `Bearer ${decryptedToken}`,
        Accept: "application/json",
      },
    });

    const userId = userResponse.data.data.id;

    // Convert HTML to Medium's content format
    const content = convertHtmlToMediumFormat(blog.content);

    // Medium API endpoint
    const url = credentials.publicationId
      ? `https://api.medium.com/v1/publications/${credentials.publicationId}/posts`
      : `https://api.medium.com/v1/users/${userId}/posts`;

    const postData = {
      title: blog.title,
      contentFormat: "html",
      content: content,
      tags: blog.tags || [],
      publishStatus: blog.status === "publish" ? "public" : "draft",
    };

    console.log(`[Medium] Publishing ${credentials.publicationId ? "to publication" : "to profile"}...`);

    const response = await axios.post(url, postData, {
      headers: {
        Authorization: `Bearer ${decryptedToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
    });

    if (response.data?.errors) {
      const error = response.data.errors[0];
      throw new Error(error.message || "Medium API error");
    }

    const postData_response = response.data.data;
    const postUrl = postData_response.url;
    const postId = postData_response.id;

    if (!postUrl) {
      throw new Error("Failed to get post URL from Medium response");
    }

    console.log(`[Medium] ✅ Post created! URL: ${postUrl}`);

    return {
      success: true,
      postId: postId,
      postUrl: postUrl,
      status: postData_response.publishStatus || "draft",
      platformResponse: postData_response,
    };
  } catch (error: any) {
    console.error("[Medium] ❌ Error creating post:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.response?.data || error.message);

    const errorMessage = error.response?.data?.errors?.[0]?.message ||
      error.response?.data?.message ||
      error.message ||
      "Failed to create Medium post";

    throw new Error(errorMessage);
  }
}

export async function testMediumConnection(
  credentials: MediumCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const decryptedToken = decryptOAuthToken(credentials.accessToken, "medium");

    const response = await axios.get("https://api.medium.com/v1/me", {
      headers: {
        Authorization: `Bearer ${decryptedToken}`,
        Accept: "application/json",
      },
      timeout: 10000,
    });

    if (response.status === 200 && response.data?.data?.id) {
      return { success: true };
    }

    return {
      success: false,
      error: "Invalid response from Medium",
    };
  } catch (error: any) {
    return {
      success: false,
      error:
        error.response?.data?.errors?.[0]?.message ||
        error.message ||
        "Failed to connect to Medium",
    };
  }
}

function convertHtmlToMediumFormat(html: string): string {
  let content = html;

  content = content.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "<h1>$1</h1>");
  content = content.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "<h2>$1</h2>");
  content = content.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "<h3>$1</h3>");
  content = content.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "<h4>$1</h4>");
  content = content.replace(/<p[^>]*>(.*?)<\/p>/gi, "<p>$1</p>");
  content = content.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "<strong>$1</strong>");
  content = content.replace(/<b[^>]*>(.*?)<\/b>/gi, "<strong>$1</strong>");
  content = content.replace(/<em[^>]*>(.*?)<\/em>/gi, "<em>$1</em>");
  content = content.replace(/<i[^>]*>(.*?)<\/i>/gi, "<em>$1</em>");
  content = content.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '<a href="$1">$2</a>');
  content = content.replace(/<ul[^>]*>(.*?)<\/ul>/gi, "<ul>$1</ul>");
  content = content.replace(/<ol[^>]*>(.*?)<\/ol>/gi, "<ol>$1</ol>");
  content = content.replace(/<li[^>]*>(.*?)<\/li>/gi, "<li>$1</li>");
  content = content.replace(/<code[^>]*>(.*?)<\/code>/gi, "<code>$1</code>");
  content = content.replace(/<pre[^>]*>(.*?)<\/pre>/gi, "<pre>$1</pre>");
  content = content.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, "<blockquote>$1</blockquote>");

  return content.trim();
}
