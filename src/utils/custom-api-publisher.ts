import axios, { type AxiosRequestConfig } from "axios";
import type { BlogPublishData, PublishResult } from "../types/publishing.types";
import { guardUrl } from "./ssrf-guard";

const CUSTOM_API_RESPONSE_LIMIT = 2 * 1024 * 1024;
const CUSTOM_API_BODY_LIMIT = 3 * 1024 * 1024;
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
]);

async function guardedCustomApiUrl(rawUrl: string): Promise<string> {
  const { url } = await guardUrl(rawUrl);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("Custom API must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Custom API URL is invalid");
  return url.toString();
}

function safeCustomHeaders(input?: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    const normalized = name.trim().toLowerCase();
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(normalized) ||
      FORBIDDEN_CUSTOM_HEADERS.has(normalized) ||
      typeof value !== "string" ||
      value.length > 2048 ||
      /[\r\n]/.test(value)
    ) {
      continue;
    }
    output[name] = value;
  }
  return output;
}

interface CustomApiCredentials {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  authType: "bearer" | "basic" | "apikey" | "oauth";
  apiKey?: string | null;
  apiSecret?: string | null;
  headers?: Record<string, string>;
  payloadMapping?: any;
  responseMapping?: any;
}

/**
 * Transform blog data based on custom payload mapping
 */
function transformPayload(
  blog: BlogPublishData,
  mapping?: any
): Record<string, any> {
  if (!mapping) {
    // Default mapping
    return {
      title: blog.title,
      content: blog.content,
      excerpt: blog.excerpt,
      slug: blog.slug,
      status: blog.status,
      featured_image: blog.featured_media,
      tags: blog.tags || [],
      categories: blog.categories || [],
    };
  }

  // Apply custom mapping
  const transformed: Record<string, any> = Object.create(null);

  for (const [targetField, sourceField] of Object.entries(mapping)) {
    if (["__proto__", "prototype", "constructor"].includes(targetField)) continue;
    if (typeof sourceField === "string") {
      // Simple field mapping
      transformed[targetField] = (blog as any)[sourceField] || "";
    } else if (typeof sourceField === "object" && sourceField !== null) {
      // Nested mapping or transformation
      transformed[targetField] = sourceField;
    }
  }

  return transformed;
}

/**
 * Extract result from response based on custom response mapping
 */
function extractResult(
  response: any,
  mapping?: any
): { postId?: string; postUrl?: string; status?: string } {
  if (!mapping) {
    // Default extraction
    return {
      postId: response.data?.id || response.id,
      postUrl: response.data?.url || response.url || response.data?.link,
      status: response.data?.status || response.status,
    };
  }

  const result: { postId?: string; postUrl?: string; status?: string } = {};

  if (mapping.postId) {
    result.postId = extractNestedValue(response, mapping.postId);
  }
  if (mapping.postUrl) {
    result.postUrl = extractNestedValue(response, mapping.postUrl);
  }
  if (mapping.status) {
    result.status = extractNestedValue(response, mapping.status);
  }

  return result;
}

/**
 * Extract nested value from object using dot notation
 */
function extractNestedValue(obj: any, path: string): string | undefined {
  const segments = path.split(".");
  if (segments.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
    return undefined;
  }
  const value = segments.reduce((current, key) => current?.[key], obj);
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

export async function publishToCustomApi(
  blog: BlogPublishData,
  credentials: CustomApiCredentials
): Promise<PublishResult> {
  try {
    const requestUrl = await guardedCustomApiUrl(credentials.url);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...safeCustomHeaders(credentials.headers),
    };

    // Add authentication headers
    switch (credentials.authType) {
      case "bearer":
        if (credentials.apiKey) {
          headers.Authorization = `Bearer ${credentials.apiKey}`;
        }
        break;
      case "basic":
        if (credentials.apiKey && credentials.apiSecret) {
          const authString = Buffer.from(
            `${credentials.apiKey}:${credentials.apiSecret}`
          ).toString("base64");
          headers.Authorization = `Basic ${authString}`;
        }
        break;
      case "apikey":
        if (credentials.apiKey) {
          headers["X-API-Key"] = credentials.apiKey;
        }
        break;
      case "oauth":
        // OAuth typically requires more complex flow
        // For now, assume token is in apiKey
        if (credentials.apiKey) {
          headers.Authorization = `Bearer ${credentials.apiKey}`;
        }
        break;
    }

    // Transform payload
    const payload = transformPayload(blog, credentials.payloadMapping);

    console.log("[CustomAPI] Publishing request");
    console.log(`[CustomAPI] Method: ${credentials.method}`);

    const config: AxiosRequestConfig = {
      method: credentials.method,
      url: requestUrl,
      headers,
      data: payload,
      timeout: 30000,
      maxRedirects: 0,
      maxContentLength: CUSTOM_API_RESPONSE_LIMIT,
      maxBodyLength: CUSTOM_API_BODY_LIMIT,
    };

    const response = await axios(config);

    console.log(`[CustomAPI] ✅ Request successful!`);
    console.log(`[CustomAPI] Status: ${response.status}`);

    // Extract result
    const result = extractResult(response, credentials.responseMapping);

    return {
      success: true,
      postId: result.postId,
      postUrl: result.postUrl,
      status: result.status || "success",
      platformResponse: response.data,
    };
  } catch (error: any) {
    console.error("[CustomAPI] ❌ Error publishing:");
    console.error("Status:", error.response?.status);
    console.error("Message:", error.message || "Custom API request failed");

    throw new Error(
      `Failed to publish to custom API: ${error.message || "request failed"}`
    );
  }
}

export async function testCustomApiConnection(
  credentials: CustomApiCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const requestUrl = await guardedCustomApiUrl(credentials.url);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...safeCustomHeaders(credentials.headers),
    };

    // Add authentication headers (same as publish)
    switch (credentials.authType) {
      case "bearer":
        if (credentials.apiKey) {
          headers.Authorization = `Bearer ${credentials.apiKey}`;
        }
        break;
      case "basic":
        if (credentials.apiKey && credentials.apiSecret) {
          const authString = Buffer.from(
            `${credentials.apiKey}:${credentials.apiSecret}`
          ).toString("base64");
          headers.Authorization = `Basic ${authString}`;
        }
        break;
      case "apikey":
        if (credentials.apiKey) {
          headers["X-API-Key"] = credentials.apiKey;
        }
        break;
      case "oauth":
        if (credentials.apiKey) {
          headers.Authorization = `Bearer ${credentials.apiKey}`;
        }
        break;
    }

    // Try a simple GET or HEAD request to test connection
    const parsedTestUrl = new URL(requestUrl);
    parsedTestUrl.pathname = `${parsedTestUrl.pathname.replace(/\/$/, "")}/health`;
    parsedTestUrl.search = "";
    parsedTestUrl.hash = "";

    const response = await axios.get(parsedTestUrl.toString(), {
      headers,
      validateStatus: (status) => status < 500, // Accept 2xx and 4xx; redirects are not followed.
      timeout: 10000,
      maxRedirects: 0,
      maxContentLength: CUSTOM_API_RESPONSE_LIMIT,
    });

    // If we get any response, connection works
    if (response.status < 500) {
      return { success: true };
    }

    return {
      success: false,
      error: `Unexpected status: ${response.status}`,
    };
  } catch (error: any) {
    // If /health endpoint doesn't exist, try the main URL with OPTIONS
    try {
      const fallbackUrl = await guardedCustomApiUrl(credentials.url);
      const response = await axios.options(fallbackUrl, {
        headers: safeCustomHeaders(credentials.headers),
        validateStatus: () => true,
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: CUSTOM_API_RESPONSE_LIMIT,
      });

      return { success: true };
    } catch (optionsError: any) {
      return {
        success: false,
        error:
          error.message ||
          "Failed to connect to custom API",
      };
    }
  }
}
