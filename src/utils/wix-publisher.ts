import axios from "axios";
import type { PublishResult, BlogPublishData } from "../types/publishing.types";

interface WixCredentials {
  siteId: string;
  oauthAccessToken: string;
  collectionId?: string | null; // Optional: Wix collection ID for blog posts
}

let nodeCounter = 0;

function nextNodeId(): string {
  return `node_${nodeCounter++}`;
}

/**
 * Convert HTML string to Wix Rich Content format.
 * Handles common HTML elements and falls back to raw HTML nodes for complex content.
 */
function convertHtmlToRichContent(html: string): any {
  nodeCounter = 0;
  const nodes: any[] = [];

  // Strip the HTML to extract structured content
  // Use a simple regex-based parser for common elements
  let remaining = html;

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (!remaining) break;

    // Headings h1-h6
    const headingMatch = remaining.match(/^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i);
    if (headingMatch) {
      const level = parseInt(headingMatch[1]!, 10);
      const innerHtml = headingMatch[2]!;
      nodes.push({
        type: "HEADING",
        id: nextNodeId(),
        headingData: { level },
        nodes: parseInlineNodes(innerHtml),
      });
      remaining = remaining.slice(headingMatch[0].length);
      continue;
    }

    // Paragraphs
    const pMatch = remaining.match(/^<p[^>]*>([\s\S]*?)<\/p>/i);
    if (pMatch) {
      const innerHtml = pMatch[1]!;
      nodes.push({
        type: "PARAGRAPH",
        id: nextNodeId(),
        nodes: parseInlineNodes(innerHtml),
      });
      remaining = remaining.slice(pMatch[0].length);
      continue;
    }

    // Unordered list
    const ulMatch = remaining.match(/^<ul[^>]*>([\s\S]*?)<\/ul>/i);
    if (ulMatch) {
      const items = parseListItems(ulMatch[1]!);
      nodes.push({
        type: "BULLETED_LIST",
        id: nextNodeId(),
        nodes: items,
      });
      remaining = remaining.slice(ulMatch[0].length);
      continue;
    }

    // Ordered list
    const olMatch = remaining.match(/^<ol[^>]*>([\s\S]*?)<\/ol>/i);
    if (olMatch) {
      const items = parseListItems(olMatch[1]!);
      nodes.push({
        type: "ORDERED_LIST",
        id: nextNodeId(),
        nodes: items,
      });
      remaining = remaining.slice(olMatch[0].length);
      continue;
    }

    // Blockquote
    const bqMatch = remaining.match(/^<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
    if (bqMatch) {
      nodes.push({
        type: "BLOCKQUOTE",
        id: nextNodeId(),
        nodes: parseInlineNodes(bqMatch[1]!),
      });
      remaining = remaining.slice(bqMatch[0].length);
      continue;
    }

    // Images
    const imgMatch = remaining.match(/^<img[^>]*src=["']([^"']+)["'][^>]*\/?>/i);
    if (imgMatch) {
      const altMatch = imgMatch[0].match(/alt=["']([^"']*)["']/i);
      nodes.push({
        type: "IMAGE",
        id: nextNodeId(),
        imageData: {
          image: { src: { url: imgMatch[1]! } },
          altText: altMatch ? altMatch[1] || "" : "",
        },
      });
      remaining = remaining.slice(imgMatch[0].length);
      continue;
    }

    // Line breaks
    const brMatch = remaining.match(/^<br\s*\/?>/i);
    if (brMatch) {
      remaining = remaining.slice(brMatch[0].length);
      continue;
    }

    // Divs — treat content inside as paragraphs
    const divMatch = remaining.match(/^<div[^>]*>([\s\S]*?)<\/div>/i);
    if (divMatch) {
      const innerContent = (divMatch[1] || "").trim();
      if (innerContent) {
        nodes.push({
          type: "PARAGRAPH",
          id: nextNodeId(),
          nodes: parseInlineNodes(innerContent),
        });
      }
      remaining = remaining.slice(divMatch[0].length);
      continue;
    }

    // Any other HTML block — embed as raw HTML node
    const otherTagMatch = remaining.match(/^<([a-zA-Z][a-zA-Z0-9]*)[^>]*>[\s\S]*?<\/\1>/i);
    if (otherTagMatch) {
      nodes.push({
        type: "HTML",
        id: nextNodeId(),
        htmlData: { html: otherTagMatch[0] },
      });
      remaining = remaining.slice(otherTagMatch[0].length);
      continue;
    }

    // Plain text (not wrapped in tags)
    const textMatch = remaining.match(/^([^<]+)/);
    if (textMatch) {
      const text = (textMatch[1] || "").trim();
      if (text) {
        nodes.push({
          type: "PARAGRAPH",
          id: nextNodeId(),
          nodes: [{ type: "TEXT", id: nextNodeId(), textData: { text } }],
        });
      }
      remaining = remaining.slice(textMatch[0].length);
      continue;
    }

    // Skip single unrecognized characters to avoid infinite loop
    remaining = remaining.slice(1);
  }

  // If no nodes were parsed, wrap entire content as HTML fallback
  if (nodes.length === 0 && html.trim()) {
    nodes.push({
      type: "HTML",
      id: nextNodeId(),
      htmlData: { html },
    });
  }

  const now = new Date().toISOString();
  return {
    nodes,
    metadata: {
      version: 1,
      createdTimestamp: now,
      updatedTimestamp: now,
    },
  };
}

function parseInlineNodes(html: string): any[] {
  const nodes: any[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i);
    if (boldMatch) {
      nodes.push({
        type: "TEXT",
        id: nextNodeId(),
        textData: {
          text: stripTags(boldMatch[1]!),
          decorations: [{ type: "BOLD" }],
        },
      });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic
    const italicMatch = remaining.match(/^<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/i);
    if (italicMatch) {
      nodes.push({
        type: "TEXT",
        id: nextNodeId(),
        textData: {
          text: stripTags(italicMatch[1]!),
          decorations: [{ type: "ITALIC" }],
        },
      });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Links
    const linkMatch = remaining.match(/^<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (linkMatch) {
      nodes.push({
        type: "TEXT",
        id: nextNodeId(),
        textData: {
          text: stripTags(linkMatch[2]!),
          decorations: [{ type: "LINK", linkData: { link: { url: linkMatch[1]! } } }],
        },
      });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/^<code>([\s\S]*?)<\/code>/i);
    if (codeMatch) {
      nodes.push({
        type: "TEXT",
        id: nextNodeId(),
        textData: {
          text: stripTags(codeMatch[1]!),
          decorations: [{ type: "BOLD" }],
        },
      });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Line break
    const brMatch = remaining.match(/^<br\s*\/?>/i);
    if (brMatch) {
      nodes.push({
        type: "TEXT",
        id: nextNodeId(),
        textData: { text: "\n" },
      });
      remaining = remaining.slice(brMatch[0].length);
      continue;
    }

    // Skip other inline tags, keep their content
    const inlineTagMatch = remaining.match(/^<[^>]+>/);
    if (inlineTagMatch) {
      remaining = remaining.slice(inlineTagMatch[0].length);
      continue;
    }

    // Plain text
    const textMatch = remaining.match(/^([^<]+)/);
    if (textMatch) {
      const text = textMatch[1]!;
      if (text) {
        nodes.push({
          type: "TEXT",
          id: nextNodeId(),
          textData: { text },
        });
      }
      remaining = remaining.slice(textMatch[0].length);
      continue;
    }

    remaining = remaining.slice(1);
  }

  // Ensure at least one text node
  if (nodes.length === 0) {
    nodes.push({
      type: "TEXT",
      id: nextNodeId(),
      textData: { text: stripTags(html) || "" },
    });
  }

  return nodes;
}

function parseListItems(html: string): any[] {
  const items: any[] = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = liRegex.exec(html)) !== null) {
    items.push({
      type: "LIST_ITEM",
      id: nextNodeId(),
      nodes: [{
        type: "PARAGRAPH",
        id: nextNodeId(),
        nodes: parseInlineNodes(match[1]!),
      }],
    });
  }

  return items;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * Publish a blog post to Wix
 * Uses Wix Blog v3 Draft Posts API with Rich Content format
 */
export async function publishToWix(
  blog: BlogPublishData,
  credentials: WixCredentials
): Promise<PublishResult> {
  try {
    const baseUrl = "https://www.wixapis.com";

    if (!credentials.oauthAccessToken) {
      throw new Error("Wix OAuth access token is required");
    }

    const headers = {
      Authorization: `Bearer ${credentials.oauthAccessToken}`,
      "Content-Type": "application/json",
      "wix-site-id": credentials.siteId,
    };

    // Convert HTML content to Wix Rich Content format
    const richContent = convertHtmlToRichContent(blog.content);

    // Build the draft post in Wix Blog v3 format
    const draftPost: any = {
      title: blog.title,
      excerpt: blog.excerpt || "",
      slug: blog.slug,
      richContent,
    };

    // Cover media
    if (blog.featured_media) {
      draftPost.coverMedia = {
        image: { url: blog.featured_media },
      };
    }

    // Tags
    if (blog.tags && blog.tags.length > 0) {
      draftPost.tags = blog.tags;
    }

    // Category IDs
    if (blog.categories && blog.categories.length > 0) {
      draftPost.categoryIds = blog.categories;
    }

    // SEO data in Wix tag-based format
    if (blog.meta) {
      draftPost.seoData = {
        tags: [
          { type: "title", children: blog.meta.seo_title || blog.title },
          {
            type: "meta",
            props: {
              name: "description",
              content: blog.meta.seo_description || blog.excerpt,
            },
          },
        ],
      };
      if (blog.meta.keywords && blog.meta.keywords.length > 0) {
        draftPost.seoData.tags.push({
          type: "meta",
          props: {
            name: "keywords",
            content: blog.meta.keywords.join(", "),
          },
        });
      }
    }

    console.log(`[Wix] Creating draft blog post for site ${credentials.siteId}...`);

    // Step 1: Create draft post
    const response = await axios.post(
      `${baseUrl}/blog/v3/draft-posts`,
      { draftPost },
      { headers }
    );

    const post = response.data.draftPost || response.data;
    const postId = post._id || post.id;

    console.log(`[Wix] Draft post created! Post ID: ${postId}`);

    // Step 2: Publish if status is "publish"
    let isPublished = false;
    if (blog.status === "publish" && postId) {
      try {
        await axios.post(
          `${baseUrl}/blog/v3/draft-posts/${postId}/publish`,
          {},
          { headers }
        );
        isPublished = true;
        console.log(`[Wix] Post published!`);
      } catch (publishError: any) {
        console.warn("[Wix] Could not publish draft post:", publishError.response?.data || publishError.message);
      }
    }

    // Construct post URL
    const postUrl = post.url ||
      (post.slug ? `https://${credentials.siteId}.wixsite.com/blog/${post.slug}` : undefined);

    return {
      success: true,
      postId,
      postUrl,
      status: isPublished ? "published" : "draft",
      platformResponse: post,
    };
  } catch (error: any) {
    console.error("[Wix] Error creating blog post:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.response?.data?.message || error.message);
    console.error("Response:", error.response?.data);

    // Handle specific Wix API errors
    if (error.response?.status === 401) {
      throw new Error("Wix authentication failed. Please reconnect your Wix account.");
    }

    if (error.response?.status === 403) {
      throw new Error("Wix access denied. Please check your app permissions.");
    }

    throw new Error(
      error.response?.data?.message ||
        error.response?.data?.error?.message ||
        `Failed to create Wix blog post: ${error.message}`
    );
  }
}

/**
 * Test Wix connection
 */
export async function testWixConnection(
  credentials: WixCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = "https://www.wixapis.com";

    if (!credentials.oauthAccessToken) {
      return {
        success: false,
        error: "Wix OAuth access token is required",
      };
    }

    // Test connection by fetching site info
    const response = await axios.get(
      `${baseUrl}/sites/v2/site/${credentials.siteId}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.oauthAccessToken}`,
          "wix-site-id": credentials.siteId,
        },
      }
    );

    if (response.status === 200 && response.data) {
      return { success: true };
    }

    return {
      success: false,
      error: "Invalid response from Wix",
    };
  } catch (error: any) {
    if (error.response?.status === 401) {
      return {
        success: false,
        error: "Wix authentication failed. Please reconnect your Wix account.",
      };
    }

    return {
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error?.message ||
        error.message ||
        "Failed to connect to Wix",
    };
  }
}
