import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, mock } from "bun:test";

const TEST_SHOPIFY_SECRET = "shopify-client-secret";

let integrationUpdates: Array<Record<string, unknown>> = [];
let tokenUpdates: Array<Record<string, unknown>> = [];

mock.module("../config/db.config", () => ({
  prisma: {
    publishingIntegration: {
      updateMany: async (payload: Record<string, unknown>) => {
        integrationUpdates.push(payload);
        return { count: 1 };
      },
    },
    shopifyOAuthToken: {
      updateMany: async (payload: Record<string, unknown>) => {
        tokenUpdates.push(payload);
        return { count: 1 };
      },
    },
    publishedBlog: {
      findFirst: async () => null,
      update: async () => null,
    },
    business: {
      findFirst: async () => null,
    },
  },
}));

mock.module("../config/pinecone.config", () => ({
  updateBlogUrl: async () => null,
}));

mock.module("../services/managed-backlinks.service", () => ({
  syncManagedBacklinksForPublishedBlog: async () => null,
}));

function signShopifyPayload(payload: string, secret = TEST_SHOPIFY_SECRET) {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

function createMockResponse() {
  let statusCode = 0;
  let body: unknown = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (value: unknown) => {
      body = value;
      return res;
    },
  };

  return {
    res,
    get body() {
      return body;
    },
    get statusCode() {
      return statusCode;
    },
  };
}

function createWebhookRequest(params: {
  payload: Record<string, unknown>;
  topic: string;
  signature?: string;
  shop?: string;
}) {
  const rawBody = JSON.stringify(params.payload);

  return {
    body: params.payload,
    headers: {
      "x-shopify-hmac-sha256":
        params.signature ?? signShopifyPayload(rawBody),
      "x-shopify-shop-domain": params.shop ?? "uplift-test.myshopify.com",
      "x-shopify-topic": params.topic,
    },
    rawBody,
  };
}

describe("Shopify webhook handling", () => {
  let controller: typeof import("../controllers/shopify-oauth.controller");

  beforeEach(async () => {
    process.env.SHOPIFY_CLIENT_SECRET = TEST_SHOPIFY_SECRET;
    integrationUpdates = [];
    tokenUpdates = [];
    controller = await import("../controllers/shopify-oauth.controller");
  });

  it("verifies Shopify webhook signatures against the raw request body", () => {
    const rawBody = JSON.stringify({ shop_domain: "uplift-test.myshopify.com" });
    const hmac = signShopifyPayload(rawBody);

    expect(
      controller.verifyShopifyWebhookHMAC({
        rawBody,
        hmac,
        clientSecret: TEST_SHOPIFY_SECRET,
      }),
    ).toBe(true);
    expect(
      controller.verifyShopifyWebhookHMAC({
        rawBody,
        hmac: signShopifyPayload(JSON.stringify({ mutated: true })),
        clientSecret: TEST_SHOPIFY_SECRET,
      }),
    ).toBe(false);
  });

  it("acknowledges mandatory customer data request compliance webhooks", async () => {
    const payload = {
      shop_id: 123,
      shop_domain: "uplift-test.myshopify.com",
      customer: { id: 456, email: "customer@example.com" },
      data_request: { id: 789 },
    };
    const mockResponse = createMockResponse();

    await controller.handleShopifyWebhook(
      createWebhookRequest({
        payload,
        topic: "customers/data_request",
      }) as unknown as Parameters<typeof controller.handleShopifyWebhook>[0],
      mockResponse.res as Parameters<typeof controller.handleShopifyWebhook>[1],
    );

    expect(mockResponse.statusCode).toBe(200);
    expect(integrationUpdates).toEqual([]);
    expect(tokenUpdates).toEqual([]);
  });

  it("returns 401 for invalid Shopify compliance webhook HMAC signatures", async () => {
    const payload = {
      shop_id: 123,
      shop_domain: "uplift-test.myshopify.com",
    };
    const mockResponse = createMockResponse();

    await controller.handleShopifyWebhook(
      createWebhookRequest({
        payload,
        topic: "shop/redact",
        signature: "bad-signature",
      }) as unknown as Parameters<typeof controller.handleShopifyWebhook>[0],
      mockResponse.res as Parameters<typeof controller.handleShopifyWebhook>[1],
    );

    expect(mockResponse.statusCode).toBe(401);
    expect(integrationUpdates).toEqual([]);
    expect(tokenUpdates).toEqual([]);
  });

  it("deactivates Shopify OAuth records for shop redaction webhooks", async () => {
    const payload = {
      shop_id: 123,
      shop_domain: "Uplift-Test.myshopify.com",
    };
    const mockResponse = createMockResponse();

    await controller.handleShopifyWebhook(
      createWebhookRequest({
        payload,
        topic: "shop/redact",
        shop: "Uplift-Test.myshopify.com",
      }) as unknown as Parameters<typeof controller.handleShopifyWebhook>[0],
      mockResponse.res as Parameters<typeof controller.handleShopifyWebhook>[1],
    );

    expect(mockResponse.statusCode).toBe(200);
    expect(integrationUpdates).toEqual([
      {
        where: {
          platform: "SHOPIFY",
          shopifyShopDomain: "uplift-test.myshopify.com",
        },
        data: {
          isActive: false,
          isVerified: false,
        },
      },
    ]);
    expect(tokenUpdates).toEqual([
      {
        where: {
          shopDomain: "uplift-test.myshopify.com",
        },
        data: {
          isActive: false,
        },
      },
    ]);
  });
});
