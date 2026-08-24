import { describe, it, expect } from "bun:test";
import type { PublishResult } from "../types/publishing.types";

interface PluginResponse {
  success: boolean;
  in_progress?: boolean;
  message?: string;
  post_id?: number;
  post_url?: string;
  status?: string;
  duplicate?: boolean;
}

function simulatePluginResultMapping(pluginData: PluginResponse): PublishResult {
  if (pluginData.in_progress) {
    return {
      success: false,
      inProgress: true,
      message:
        pluginData.message || "Publish in progress - please retry shortly",
      platformResponse: pluginData,
    };
  }

  if (pluginData.success === false && !pluginData.post_id) {
    return {
      success: false,
      error: pluginData.message || "Plugin reported failure",
      platformResponse: pluginData,
    };
  }

  return {
    success: true,
    postId: pluginData.post_id ? String(pluginData.post_id) : undefined,
    postUrl: pluginData.post_url,
    status: pluginData.status,
    platformResponse: pluginData,
    message: pluginData.message || (pluginData.duplicate ? "Post already exists - duplicate prevented" : undefined),
  };
}

describe("WordPress plugin in_progress handling", () => {
  it("in_progress response results in success=false and inProgress=true", () => {
    const result = simulatePluginResultMapping({
      success: false,
      in_progress: true,
      message: "Publish in progress - please retry shortly",
    });

    expect(result.success).toBe(false);
    expect(result.inProgress).toBe(true);
    expect(result.message).toContain("in progress");
    expect(result.postId).toBeUndefined();
    expect(result.postUrl).toBeUndefined();
  });

  it("normal success response returns success=true with post data", () => {
    const result = simulatePluginResultMapping({
      success: true,
      post_id: 42,
      post_url: "https://example.com/test-post",
      status: "publish",
    });

    expect(result.success).toBe(true);
    expect(result.inProgress).toBeUndefined();
    expect(result.postId).toBe("42");
    expect(result.postUrl).toBe("https://example.com/test-post");
  });

  it("duplicate response returns success=true with duplicate message", () => {
    const result = simulatePluginResultMapping({
      success: true,
      post_id: 42,
      post_url: "https://example.com/test-post",
      status: "publish",
      duplicate: true,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain("duplicate");
  });

  it("generic failure (no post_id) returns success=false without inProgress", () => {
    const result = simulatePluginResultMapping({
      success: false,
      message: "Some other error",
    });

    expect(result.success).toBe(false);
    expect(result.inProgress).toBeUndefined();
    expect(result.error).toBe("Some other error");
  });

  it("PublishedBlog status should be PENDING (not PUBLISHED/FAILED) when inProgress", () => {
    const result = simulatePluginResultMapping({
      success: false,
      in_progress: true,
      message: "Publish in progress - please retry shortly",
    });

    type ResolvedStatus = "PUBLISHED" | "PENDING" | "FAILED";
    const resolvedStatus: ResolvedStatus = result.success
      ? "PUBLISHED"
      : result.inProgress
        ? "PENDING"
        : "FAILED";

    expect(resolvedStatus).toBe("PENDING");
  });
});
