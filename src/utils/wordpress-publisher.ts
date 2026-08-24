import axios from "axios";
import type { BlogPublishData, PublishResult } from "../types/publishing.types";
import { guardUrl } from "./ssrf-guard";

const WORDPRESS_RESPONSE_LIMIT = 2 * 1024 * 1024;
const WORDPRESS_IMAGE_LIMIT = 10 * 1024 * 1024;
const WORDPRESS_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

type WordPressImageMimeType = keyof typeof WORDPRESS_IMAGE_TYPES;

export interface InspectedWordPressImage {
  data: Buffer;
  contentType: WordPressImageMimeType;
  extension: (typeof WORDPRESS_IMAGE_TYPES)[WordPressImageMimeType];
}

function detectedImageType(data: Buffer): WordPressImageMimeType | null {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function inspectWordPressFeaturedImage(
  rawData: ArrayBuffer | ArrayBufferView,
  rawContentType: unknown,
): InspectedWordPressImage {
  const data = Buffer.isBuffer(rawData)
    ? rawData
    : ArrayBuffer.isView(rawData)
      ? Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength)
      : Buffer.from(rawData);
  if (data.length === 0 || data.length > WORDPRESS_IMAGE_LIMIT) {
    throw new Error("Featured image payload is invalid");
  }

  const normalizedContentType =
    typeof rawContentType === "string"
      ? (rawContentType.split(";", 1)[0] ?? "").trim().toLowerCase()
      : "";
  if (!(normalizedContentType in WORDPRESS_IMAGE_TYPES)) {
    throw new Error("Featured image type is not allowed");
  }

  const detectedContentType = detectedImageType(data);
  if (detectedContentType !== normalizedContentType) {
    throw new Error("Featured image content does not match its declared type");
  }

  const contentType = normalizedContentType as WordPressImageMimeType;
  return {
    data,
    contentType,
    extension: WORDPRESS_IMAGE_TYPES[contentType],
  };
}

export function wordpressMediaFilename(slug: string, extension: string): string {
  const safeSlug = slug
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `${safeSlug || "featured"}-featured-image.${extension}`;
}

async function guardedWordPressBaseUrl(rawUrl: string): Promise<string> {
  const { url } = await guardUrl(rawUrl);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("WordPress site must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("WordPress URL must not contain credentials");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function guardedImageUrl(rawUrl: string): Promise<string> {
  const { url } = await guardUrl(rawUrl);
  if (url.protocol !== "https:") throw new Error("Featured image must use HTTPS");
  if (url.username || url.password) throw new Error("Featured image URL is invalid");
  return url.toString();
}

/** Compare semver strings. Returns true if `version` >= `minVersion`. */
function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(minVersion);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true; // equal
}

interface WordPressCredentials {
  websiteUrl: string;
  // REST API credentials (legacy)
  username?: string;
  appPassword?: string;
  // Plugin integration key (new)
  integrationKey?: string;
  connectionMethod?: "REST_API" | "PLUGIN";
}

export async function publishToWordPress(
  blog: BlogPublishData,
  credentials: WordPressCredentials
): Promise<PublishResult> {
  credentials = {
    ...credentials,
    websiteUrl: await guardedWordPressBaseUrl(credentials.websiteUrl),
  };
  // Check if using plugin or REST API
  if (credentials.connectionMethod === "PLUGIN" && credentials.integrationKey) {
    return await publishViaPlugin(blog, credentials);
  } else {
    return await publishViaRestApi(blog, credentials);
  }
}

/**
 * Publish via WordPress Plugin (Integration Key)
 */
async function publishViaPlugin(
  blog: BlogPublishData,
  credentials: WordPressCredentials
): Promise<PublishResult> {
  try {
    console.log(`[WordPress Plugin] Publishing blog ${blog.id} via plugin...`);

    // Note: We don't check for existing posts here because:
    // 1. WordPress REST API doesn't support querying by custom meta fields reliably
    // 2. The plugin handles duplicate checking internally using get_posts() which works correctly
    // 3. The plugin will return existing post info if found, or create new one

    // Prepare publish_date from blogPublishDate and blogPublishTime
    let publishDate: string | undefined;
    if (blog.blogPublishDate) {
      if (blog.blogPublishTime) {
        // Combine date and time: "YYYY-MM-DD HH:MM:SS"
        // blogPublishTime might be "HH:MM" or "HH:MM:SS", so we handle both
        const timeParts = blog.blogPublishTime.split(":");
        if (timeParts.length === 2) {
          // Format: "HH:MM" - add seconds
          publishDate = `${blog.blogPublishDate} ${blog.blogPublishTime}:00`;
        } else {
          // Format: "HH:MM:SS" - use as is
          publishDate = `${blog.blogPublishDate} ${blog.blogPublishTime}`;
        }
      } else {
        // Use date with default time (midnight)
        publishDate = `${blog.blogPublishDate} 00:00:00`;
      }
      console.log(`[WordPress Plugin] Publishing with date: ${publishDate}`);
    } else {
      console.log(
        `[WordPress Plugin] No publish date specified, using current date/time`
      );
    }

    console.log(
      `[WordPress Plugin] Publishing with status: ${blog.status.toLowerCase()}`
    );

    const metaFields: Record<string, string> = {
      seo_tool_blog_id: blog.id,
      seo_tool_keyword: blog.meta?.focus_keyword || "",
    };
    if (blog.attemptId) {
      metaFields.seo_tool_attempt_id = blog.attemptId;
    }

    const requestBody: Record<string, unknown> = {
      title: blog.title,
      content: blog.content,
      excerpt: blog.excerpt || "",
      slug: blog.slug,
      status: blog.status.toLowerCase(),
      featured_media_url: blog.featured_media,
      publish_date: publishDate,
      seo_title: blog.meta?.seo_title || blog.title,
      seo_description: blog.meta?.seo_description || blog.excerpt || "",
      og_title: blog.meta?.og_title || blog.meta?.seo_title || blog.title,
      og_description:
        blog.meta?.og_description || blog.meta?.seo_description || blog.excerpt || "",
      og_type: blog.meta?.og_type || "article",
      og_url: blog.meta?.og_url || "",
      og_site_name: blog.meta?.og_site_name || "",
      og_locale: blog.meta?.og_locale || "",
      article_author: blog.meta?.article_author || "",
      article_section: blog.meta?.article_section || "",
      article_tags: blog.meta?.article_tags || [],
      meta_fields: metaFields,
      force_update: blog.forceUpdate || false,
    };

    if (blog.forceUpdate) {
      console.log(`[WordPress Plugin] Force update enabled for blog ${blog.id}`);
      if (blog.externalPostId) {
        console.log(`[WordPress Plugin] Existing post ID: ${blog.externalPostId}`);
      }
    }

    if (blog.attemptId) {
      console.log(`[WordPress Plugin] attemptId=${blog.attemptId}`);
    }

    let response;
    try {
      response = await axios.post(
        `${credentials.websiteUrl}/wp-json/seo-tool/v1/publish`,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${credentials.integrationKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
          maxRedirects: 0,
          maxContentLength: WORDPRESS_RESPONSE_LIMIT,
          maxBodyLength: 3 * 1024 * 1024,
        }
      );
    } catch (axiosError: any) {
      throw axiosError;
    }

    if (response.data.in_progress) {
      console.log(
        `⏳ [WordPress Plugin] Publish in progress for blog ${blog.id} – not treating as success`
      );
      return {
        success: false,
        inProgress: true,
        message: response.data.message || "Publish in progress - please retry shortly",
        platformResponse: response.data,
      };
    }

    if (response.data.success === false && !response.data.post_id) {
      console.log(
        `[WordPress Plugin] Plugin returned success=false for blog ${blog.id}: ${response.data.message ?? ""}`
      );
      return {
        success: false,
        error: response.data.message || "Plugin reported failure",
        platformResponse: response.data,
      };
    }

    const isUpdate = response.data.updated === true;
    const actionWord = isUpdate ? "updated" : "created";
    
    console.log(`[WordPress Plugin] ✅ Blog post ${actionWord}!`);
    console.log(`[WordPress Plugin] Post ID: ${response.data.post_id}`);
    console.log(`[WordPress Plugin] Post URL: ${response.data.post_url}`);

    if (response.data.duplicate) {
      console.log(
        `⚠️ [WordPress Plugin] Post already exists - duplicate prevented (from plugin)`
      );
    }

    return {
      success: true,
      postId: String(response.data.post_id),
      postUrl: response.data.post_url,
      status: response.data.status,
      platformResponse: response.data,
      message:
        response.data.message ||
        (response.data.duplicate
          ? "Post already exists - duplicate prevented"
          : isUpdate
            ? "Post updated successfully"
            : undefined),
    };
  } catch (error: any) {
    console.error("[WordPress Plugin] ❌ Error creating blog post:");
    console.error("Status:", error.response?.status);
    console.error("Response Headers:", error.response?.headers);
    
    if (error.response && error.response.data) {
      const responseData = error.response.data;
      
      if (typeof responseData === "object" && responseData.post_id) {
        console.warn(
          `[WordPress Plugin] ⚠️ WordPress returned error but post was created. Post ID: ${responseData.post_id}`
        );
        return {
          success: true,
          postId: String(responseData.post_id),
          postUrl: responseData.post_url || "",
          status: responseData.status || "publish",
          platformResponse: responseData,
          message: "Post created but WordPress reported an error. Check WordPress logs.",
        };
      }
    }
    
    let errorMessage = "Failed to create WordPress post via plugin";
    
    if (error.response) {
      const responseData = error.response.data;
      const statusCode = error.response.status;
      
      if (typeof responseData === "string") {
        if (responseData.includes("critical error") || responseData.includes("<p>")) {
          errorMessage = "WordPress fatal error occurred. The post may have been created before the error. Check WordPress admin and debug logs.";
          console.error("[WordPress Plugin] HTML Error Response:", responseData.substring(0, 500));
          
          if (statusCode === 500) {
            console.warn(
              "[WordPress Plugin] ⚠️ WordPress fatal error (500) - post may have been created before error occurred."
            );
            console.warn(
              "[WordPress Plugin] ⚠️ Check WordPress admin and debug logs to verify if post was created."
            );
          }
        } else {
          errorMessage = responseData.substring(0, 200);
        }
      } else if (responseData && typeof responseData === "object") {
        if (responseData.post_id) {
          console.warn(
            `[WordPress Plugin] ⚠️ WordPress returned error but post was created. Post ID: ${responseData.post_id}`
          );
          return {
            success: true,
            postId: String(responseData.post_id),
            postUrl: responseData.post_url || "",
            status: responseData.status || "publish",
            platformResponse: responseData,
            message: "Post created but WordPress reported an error. Check WordPress logs.",
          };
        }
        errorMessage = responseData.message || responseData.error || errorMessage;
      }
      
      if (statusCode === 500) {
        errorMessage = `WordPress server error (500): ${errorMessage}. Check WordPress debug logs.`;
      }
    } else {
      errorMessage = error.message || errorMessage;
    }
    
    console.error("[WordPress Plugin] Error Message:", errorMessage);
    
    throw new Error(errorMessage);
  }
}

/**
 * Publish via WordPress REST API (legacy)
 */
async function publishViaRestApi(
  blog: BlogPublishData,
  credentials: WordPressCredentials
): Promise<PublishResult> {
  try {
    if (!credentials.username || !credentials.appPassword) {
      throw new Error(
        "WordPress username and password are required for REST API mode"
      );
    }

    const cleanPassword = credentials.appPassword!.replace(/\s/g, "");
    const authString = Buffer.from(
      `${credentials.username}:${cleanPassword}`
    ).toString("base64");

    const authHeader = {
      Authorization: `Basic ${authString}`,
      "Content-Type": "application/json",
    };

    try {
      const checkExistingResponse = await axios.get(
        `${credentials.websiteUrl}/wp-json/wp/v2/posts`,
        {
          params: {
            slug: blog.slug,
            per_page: 1,
          },
          headers: authHeader,
          timeout: 15000,
          maxRedirects: 0,
          maxContentLength: WORDPRESS_RESPONSE_LIMIT,
        }
      );

      if (
        checkExistingResponse?.data &&
        Array.isArray(checkExistingResponse.data) &&
        checkExistingResponse.data.length > 0
      ) {
        const existingPost = checkExistingResponse.data[0];
        console.log(
          `⚠️ [WordPress REST API] Post already exists with slug: ${blog.slug} - Post ID: ${existingPost.id}`
        );
        return {
          success: true,
          postId: String(existingPost.id),
          postUrl: existingPost.link,
          status: existingPost.status,
          platformResponse: existingPost,
          message: "Post already exists - duplicate prevented",
        };
      }
    } catch (checkError: any) {
      console.log(
        `[WordPress REST API] Could not check for existing post (continuing): ${checkError.message}`
      );
    }

    // Upload featured image if provided
    let featuredMediaId: number | null = null;

    if (blog.featured_media) {
      try {
        const safeImageUrl = await guardedImageUrl(blog.featured_media);
        const imageResponse = await axios.get(safeImageUrl, {
          responseType: "arraybuffer",
          timeout: 20000,
          maxRedirects: 0,
          maxContentLength: WORDPRESS_IMAGE_LIMIT,
        });

        const image = inspectWordPressFeaturedImage(
          imageResponse.data,
          imageResponse.headers["content-type"],
        );
        const filename = wordpressMediaFilename(blog.slug, image.extension);

        console.log(`[WordPress] Uploading featured image...`);

        const mediaResponse = await axios.post(
          `${credentials.websiteUrl}/wp-json/wp/v2/media`,
          image.data,
          {
            headers: {
              Authorization: `Basic ${authString}`,
              "Content-Type": image.contentType,
              "Content-Disposition": `attachment; filename="${filename}"`,
            },
            decompress: false,
            validateStatus: null,
            timeout: 30000,
            maxRedirects: 0,
            maxContentLength: WORDPRESS_RESPONSE_LIMIT,
            maxBodyLength: WORDPRESS_IMAGE_LIMIT,
          }
        );

        if (mediaResponse.status === 201 || mediaResponse.status === 200) {
          featuredMediaId = mediaResponse.data.id;
          console.log(
            `[WordPress] ✅ Featured image uploaded. Media ID: ${featuredMediaId}`
          );
        } else {
          console.warn(
            `[WordPress] ⚠️ Failed to upload featured image: ${mediaResponse.status}`
          );
        }
      } catch (error: any) {
        console.error("[WordPress] ❌ Error uploading featured image:", error);
        // Continue without featured image
      }
    }

    // Prepare publish date from blogPublishDate and blogPublishTime
    let publishDate: string | undefined;
    if (blog.blogPublishDate) {
      if (blog.blogPublishTime) {
        // Combine date and time: "YYYY-MM-DDTHH:MM:SS" (ISO format for REST API)
        // blogPublishTime might be "HH:MM" or "HH:MM:SS", so we handle both
        const timeParts = blog.blogPublishTime.split(":");
        if (timeParts.length === 2) {
          // Format: "HH:MM" - add seconds
          publishDate = `${blog.blogPublishDate}T${blog.blogPublishTime}:00`;
        } else {
          // Format: "HH:MM:SS" - use as is
          publishDate = `${blog.blogPublishDate}T${blog.blogPublishTime}`;
        }
      } else {
        // Use date with default time (midnight)
        publishDate = `${blog.blogPublishDate}T00:00:00`;
      }
      console.log(`[WordPress REST API] Publishing with date: ${publishDate}`);
    } else {
      console.log(
        `[WordPress REST API] No publish date specified, using current date/time`
      );
    }

    // Create blog post
    const postData: any = {
      title: blog.title,
      content: blog.content,
      status: blog.status.toLowerCase(),
      excerpt: blog.excerpt,
      slug: blog.slug,
    };

    // WordPress REST API uses 'date' parameter for publish date
    if (publishDate) {
      postData.date = publishDate;
    }

    if (featuredMediaId) {
      postData.featured_media = featuredMediaId;
    }

    console.log(
      `[WordPress REST API] Publishing with status: ${blog.status.toLowerCase()}`
    );
    console.log("[WordPress] Creating blog post...");

    const response = await axios.post(
      `${credentials.websiteUrl}/wp-json/wp/v2/posts`,
      postData,
      {
        headers: authHeader,
        timeout: 30000,
        maxRedirects: 0,
        maxContentLength: WORDPRESS_RESPONSE_LIMIT,
        maxBodyLength: 3 * 1024 * 1024,
      }
    );

    console.log(`[WordPress] ✅ Blog post created!`);
    console.log(`[WordPress] Post ID: ${response.data.id}`);
    console.log(`[WordPress] Post URL: ${response.data.link}`);

    return {
      success: true,
      postId: String(response.data.id),
      postUrl: response.data.link,
      status: response.data.status,
      platformResponse: response.data,
    };
  } catch (error: any) {
    console.error("[WordPress] ❌ Error creating blog post:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.response?.data?.message || error.message);

    throw new Error(
      error.response?.data?.message ||
        `Failed to create WordPress post: ${error.message}`
    );
  }
}

export interface WordPressUpdateData {
  postId: string;
  content?: string;
  title?: string;
  excerpt?: string;
  seoTitle?: string;
  seoDescription?: string;
  ogTitle?: string;
  ogDescription?: string;
  source?: string;
}

export interface WordPressUpdateResult {
  success: boolean;
  postId?: string;
  postUrl?: string;
  updatedFields?: string[];
  versionCount?: number;
  error?: string;
  pluginVersion?: string;
}

/**
 * Update existing WordPress post content via plugin /update endpoint.
 * Requires plugin v2.1.0+ with the /update route.
 */
export async function updateWordPressContent(
  data: WordPressUpdateData,
  credentials: WordPressCredentials
): Promise<WordPressUpdateResult> {
  if (credentials.connectionMethod !== "PLUGIN" || !credentials.integrationKey) {
    return {
      success: false,
      error: "WordPress content update requires PLUGIN connection method with integration key",
    };
  }

  try {
    const websiteUrl = await guardedWordPressBaseUrl(credentials.websiteUrl);
    // Check plugin version before attempting update
    const statusResponse = await axios.get(
      `${websiteUrl}/wp-json/seo-tool/v1/status`,
      {
        headers: {
          Authorization: `Bearer ${credentials.integrationKey}`,
        },
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: WORDPRESS_RESPONSE_LIMIT,
      }
    );

    const pluginVersion = statusResponse.data?.plugin_version;
    if (pluginVersion && !isVersionAtLeast(pluginVersion, "2.1.0")) {
      return {
        success: false,
        error: `WordPress plugin version ${pluginVersion} does not support content updates. Requires v2.1.0+.`,
        pluginVersion,
      };
    }

    const requestBody: Record<string, unknown> = {
      post_id: data.postId,
      source: data.source || "dr_optimization",
    };

    if (data.content !== undefined) requestBody.content = data.content;
    if (data.title !== undefined) requestBody.title = data.title;
    if (data.excerpt !== undefined) requestBody.excerpt = data.excerpt;
    if (data.seoTitle !== undefined) requestBody.seo_title = data.seoTitle;
    if (data.seoDescription !== undefined) requestBody.seo_description = data.seoDescription;
    if (data.ogTitle !== undefined) requestBody.og_title = data.ogTitle;
    if (data.ogDescription !== undefined) requestBody.og_description = data.ogDescription;

    const response = await axios.put(
      `${websiteUrl}/wp-json/seo-tool/v1/update`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${credentials.integrationKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
        maxRedirects: 0,
        maxContentLength: WORDPRESS_RESPONSE_LIMIT,
        maxBodyLength: 3 * 1024 * 1024,
      }
    );

    if (response.data.success) {
      console.log(`[WordPress Plugin] Content updated for post ${data.postId}`);
      return {
        success: true,
        postId: String(response.data.post_id),
        postUrl: response.data.post_url,
        updatedFields: response.data.updated_fields,
        versionCount: response.data.version_count,
        pluginVersion: response.data.plugin_version,
      };
    }

    return {
      success: false,
      error: response.data.message || "Plugin reported update failure",
    };
  } catch (error: any) {
    const statusCode = error.response?.status;
    const message = error.response?.data?.message || error.message;

    // 404 likely means the /update route doesn't exist (old plugin version)
    if (statusCode === 404) {
      return {
        success: false,
        error: "WordPress plugin does not have /update endpoint. Update plugin to v2.1.0+.",
      };
    }

    console.error(`[WordPress Plugin] Content update failed for post ${data.postId}:`, message);
    return {
      success: false,
      error: `Failed to update WordPress content: ${message}`,
    };
  }
}

export async function testWordPressConnection(
  credentials: WordPressCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const websiteUrl = await guardedWordPressBaseUrl(credentials.websiteUrl);
    if (!credentials.username || !credentials.appPassword) {
      return {
        success: false,
        error: "WordPress username and password are required",
      };
    }

    const cleanPassword = credentials.appPassword.replace(/\s/g, "");
    const authString = Buffer.from(
      `${credentials.username}:${cleanPassword}`
    ).toString("base64");

    const response = await axios.get(
      `${websiteUrl}/wp-json/wp/v2/users/me`,
      {
        headers: {
          Authorization: `Basic ${authString}`,
        },
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: WORDPRESS_RESPONSE_LIMIT,
      }
    );

    if (response.status === 200) {
      return { success: true };
    }

    return {
      success: false,
      error: "Invalid response from WordPress",
    };
  } catch (error: any) {
    return {
      success: false,
      error:
        error.response?.data?.message ||
        error.message ||
        "Failed to connect to WordPress",
    };
  }
}
