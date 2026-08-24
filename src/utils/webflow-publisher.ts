import axios from "axios";
import type { PublishResult, BlogPublishData } from "../types/publishing.types";

interface WebflowCredentials {
  siteId: string;
  // API Key credentials (legacy)
  apiKey?: string;
  // OAuth credentials (new)
  oauthAccessToken?: string;
  connectionMethod?: "API_KEY" | "OAUTH";
  collectionId?: string | null;
}

interface WebflowFieldMapping {
  contentFieldSlug?: string;
  excerptFieldSlug?: string;
  imageFieldSlug?: string;
  tagsFieldSlug?: string;
}

const CONTENT_SLUGS = ["post-body", "body", "content", "article", "blog-content", "post-content"];
const CONTENT_NAMES = ["post body", "body", "content", "article", "blog content"];
const EXCERPT_SLUGS = ["excerpt", "summary", "description", "short-description"];
const EXCERPT_NAMES = ["excerpt", "summary", "description", "short description"];
const IMAGE_SLUGS = ["featured-image", "cover", "thumbnail", "image", "hero-image", "cover-image", "hero", "main-image"];
const IMAGE_NAMES = ["featured image", "cover", "thumbnail", "image", "hero image", "cover image", "main image"];
const TAGS_SLUGS = ["tags", "categories", "labels", "topic", "topics"];

async function discoverFieldMapping(
  collectionId: string,
  headers: Record<string, string>,
  baseUrl: string
): Promise<WebflowFieldMapping> {
  const mapping: WebflowFieldMapping = {};

  try {
    const response = await axios.get(
      `${baseUrl}/collections/${collectionId}`,
      { headers }
    );

    const fields: Array<{ slug: string; displayName: string; type: string }> =
      response.data?.fields || [];

    // First pass: match by slug
    for (const field of fields) {
      const slug = field.slug.toLowerCase();

      if (!mapping.contentFieldSlug && CONTENT_SLUGS.includes(slug)) {
        mapping.contentFieldSlug = field.slug;
      }
      if (!mapping.excerptFieldSlug && EXCERPT_SLUGS.includes(slug)) {
        mapping.excerptFieldSlug = field.slug;
      }
      if (!mapping.imageFieldSlug && IMAGE_SLUGS.includes(slug)) {
        mapping.imageFieldSlug = field.slug;
      }
      if (!mapping.tagsFieldSlug && TAGS_SLUGS.includes(slug)) {
        mapping.tagsFieldSlug = field.slug;
      }
    }

    // Second pass: match by displayName for any unresolved fields
    for (const field of fields) {
      const name = field.displayName.toLowerCase().trim();

      if (!mapping.contentFieldSlug && CONTENT_NAMES.includes(name)) {
        mapping.contentFieldSlug = field.slug;
      }
      if (!mapping.excerptFieldSlug && EXCERPT_NAMES.includes(name)) {
        mapping.excerptFieldSlug = field.slug;
      }
      if (!mapping.imageFieldSlug && IMAGE_NAMES.includes(name)) {
        mapping.imageFieldSlug = field.slug;
      }
      if (!mapping.tagsFieldSlug && TAGS_SLUGS.includes(name)) {
        mapping.tagsFieldSlug = field.slug;
      }
    }
  } catch (error: any) {
    console.warn("[Webflow] Could not discover field mapping, using defaults:", error.message);
    // Fall back to legacy defaults for backward compatibility
    mapping.contentFieldSlug = "post-body";
    mapping.excerptFieldSlug = "excerpt";
    mapping.imageFieldSlug = "featured-image";
  }

  return mapping;
}

export async function publishToWebflow(
  blog: BlogPublishData,
  credentials: WebflowCredentials
): Promise<PublishResult> {
  try {
    const baseUrl = "https://api.webflow.com/v2";

    // Use OAuth token if available, otherwise use API key
    const accessToken = credentials.connectionMethod === "OAUTH" && credentials.oauthAccessToken
      ? credentials.oauthAccessToken
      : credentials.apiKey;

    if (!accessToken) {
      throw new Error("Webflow access token or API key is required");
    }

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    if (!credentials.collectionId) {
      throw new Error(
        "Collection ID is required. Please provide a Webflow CMS collection ID."
      );
    }

    // Upload featured image if provided
    let imageId: string | null = null;

    if (blog.featured_media) {
      try {
        console.log(`[Webflow] Using featured image URL: ${blog.featured_media}`);
        imageId = blog.featured_media;
      } catch (error: any) {
        console.warn("[Webflow] Could not process featured image:", error);
      }
    }

    // Discover field slugs for this collection
    const fieldMapping = await discoverFieldMapping(
      credentials.collectionId,
      headers,
      baseUrl
    );

    // Create CMS item with dynamically discovered field slugs
    const fieldData: Record<string, any> = {
      name: blog.title,
      slug: blog.slug,
    };

    if (fieldMapping.contentFieldSlug) {
      fieldData[fieldMapping.contentFieldSlug] = blog.content;
    }
    if (fieldMapping.excerptFieldSlug && blog.excerpt) {
      fieldData[fieldMapping.excerptFieldSlug] = blog.excerpt;
    }
    if (fieldMapping.imageFieldSlug && imageId) {
      fieldData[fieldMapping.imageFieldSlug] = imageId;
    }
    if (fieldMapping.tagsFieldSlug && blog.tags && blog.tags.length > 0) {
      fieldData[fieldMapping.tagsFieldSlug] = blog.tags.join(",");
    }

    const itemData: any = { fieldData };

    // Determine publish status
    if (blog.status === "publish") {
      itemData.isArchived = false;
      itemData.isDraft = false;
    } else {
      itemData.isDraft = true;
    }

    console.log(`[Webflow] Creating CMS item in collection ${credentials.collectionId}...`);

    const response = await axios.post(
      `${baseUrl}/collections/${credentials.collectionId}/items`,
      itemData,
      { headers }
    );

    const item = response.data;

    console.log(`[Webflow] CMS item created! Item ID: ${item.id}`);

    // Publish if needed
    if (blog.status === "publish" && !item.isDraft) {
      try {
        await axios.post(
          `${baseUrl}/collections/${credentials.collectionId}/items/publish`,
          { itemIds: [item.id] },
          { headers }
        );
        console.log(`[Webflow] Item published!`);
      } catch (publishError: any) {
        console.warn("[Webflow] Could not publish item:", publishError);
      }
    }

    return {
      success: true,
      postId: item.id,
      postUrl: item.fieldData?.slug
        ? `https://${credentials.siteId}.webflow.io/${item.fieldData.slug}`
        : undefined,
      status: item.isDraft ? "draft" : "published",
      platformResponse: item,
    };
  } catch (error: any) {
    console.error("[Webflow] Error creating CMS item:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.response?.data?.message || error.message);

    throw new Error(
      error.response?.data?.message ||
        `Failed to create Webflow item: ${error.message}`
    );
  }
}

export async function testWebflowConnection(
  credentials: WebflowCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = "https://api.webflow.com/v2";

    // Use OAuth token if available, otherwise use API key
    const accessToken = credentials.connectionMethod === "OAUTH" && credentials.oauthAccessToken
      ? credentials.oauthAccessToken
      : credentials.apiKey;

    if (!accessToken) {
      return {
        success: false,
        error: "Webflow access token or API key is required",
      };
    }

    const response = await axios.get(`${baseUrl}/sites/${credentials.siteId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 200 && response.data) {
      return { success: true };
    }

    return {
      success: false,
      error: "Invalid response from Webflow",
    };
  } catch (error: any) {
    return {
      success: false,
      error:
        error.response?.data?.message ||
        error.message ||
        "Failed to connect to Webflow",
    };
  }
}
