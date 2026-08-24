import { beforeEach, describe, expect, it } from "bun:test";
import {
  normalizeShopifyDomain,
  parseShopifyOAuthContext,
  resolveShopifyOAuthCredentials,
  serializeShopifyOAuthContext,
} from "../utils/shopify-oauth.utils";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("shopify-oauth utils", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  it("normalizes bare Shopify shop names to myshopify domains", () => {
    expect(normalizeShopifyDomain("uplift-3")).toBe("uplift-3.myshopify.com");
    expect(normalizeShopifyDomain("https://Uplift-3.myshopify.com/")).toBe(
      "uplift-3.myshopify.com",
    );
  });

  it("round-trips the encrypted OAuth context payload", () => {
    const encrypted = serializeShopifyOAuthContext({
      state: "state-123",
      shop: "uplift-3",
      clientId: "client-id",
      clientSecret: "client-secret",
      businessId: "biz-1",
      apiVersion: "2026-01",
      apiMethod: "GRAPHQL",
      blogId: "gid://shopify/OnlineStoreBlog/1",
      autoPublish: true,
      publishAs: "PUBLISH",
    });

    expect(parseShopifyOAuthContext(encrypted)).toEqual({
      state: "state-123",
      shop: "uplift-3.myshopify.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      businessId: "biz-1",
      apiVersion: "2026-01",
      apiMethod: "GRAPHQL",
      blogId: "gid://shopify/OnlineStoreBlog/1",
      autoPublish: true,
      publishAs: "PUBLISH",
    });
  });

  it("uses matching temp credentials before falling back to env credentials", () => {
    const resolved = resolveShopifyOAuthCredentials({
      state: "state-123",
      shop: "uplift-3.myshopify.com",
      tempContext: {
        state: "state-123",
        shop: "uplift-3",
        clientId: "temp-client",
        clientSecret: "temp-secret",
      },
      envClientId: "env-client",
      envClientSecret: "env-secret",
    });

    expect(resolved).toEqual({
      clientId: "temp-client",
      clientSecret: "temp-secret",
      source: "TEMP",
    });
  });

  it("falls back to env credentials when the temp context does not match", () => {
    const resolved = resolveShopifyOAuthCredentials({
      state: "state-456",
      shop: "uplift-3.myshopify.com",
      tempContext: {
        state: "state-123",
        shop: "uplift-3",
        clientId: "temp-client",
        clientSecret: "temp-secret",
      },
      envClientId: "env-client",
      envClientSecret: "env-secret",
    });

    expect(resolved).toEqual({
      clientId: "env-client",
      clientSecret: "env-secret",
      source: "ENV",
    });
  });
});
