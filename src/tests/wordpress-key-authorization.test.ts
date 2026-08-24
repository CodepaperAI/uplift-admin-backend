import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import type { Response } from "express";

const businessFindFirstMock = mock();
const integrationFindFirstMock = mock();
const integrationFindUniqueMock = mock();
const integrationUpdateManyMock = mock();
const integrationUpsertMock = mock();
const integrationUpdateMock = mock();

mock.module("../config/db.config", () => ({
  prisma: {
    business: { findFirst: businessFindFirstMock },
    publishingIntegration: {
      findFirst: integrationFindFirstMock,
      findUnique: integrationFindUniqueMock,
      update: integrationUpdateMock,
      updateMany: integrationUpdateManyMock,
      upsert: integrationUpsertMock,
    },
  },
}));

mock.module("../config/pinecone.config", () => ({
  updateBlogUrl: async () => undefined,
}));

mock.module("../services/managed-backlinks.service", () => ({
  syncManagedBacklinksForPublishedBlog: async () => undefined,
}));

const {
  generateIntegrationKey,
  handleWordPressWebhook,
  revokeIntegrationKey,
  validateIntegrationKey,
} = await import("../controllers/wordpress-oauth.controller");

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const INTEGRATION_ID = "33333333-3333-4333-8333-333333333333";

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as unknown as Response & {
    statusCode: number;
    body: {
      success: boolean;
      message: string;
      data?: Record<string, unknown>;
      error?: unknown;
    };
  };
}

function request(body: Record<string, unknown>, authUserId?: string) {
  return { body, authUserId, query: {} } as never;
}

describe("WordPress integration key administration", () => {
  beforeEach(() => {
    process.env.WORDPRESS_KEY_HMAC_SECRET =
      "wordpress-test-hmac-secret-that-is-at-least-32-bytes";
    businessFindFirstMock.mockReset();
    integrationFindFirstMock.mockReset();
    integrationFindUniqueMock.mockReset();
    integrationUpdateManyMock.mockReset();
    integrationUpsertMock.mockReset();
    integrationUpdateMock.mockReset();
  });

  it("requires backend authentication on generation and revocation routes", () => {
    const source = readFileSync(
      new URL("../routes/wordpress-oauth.routes.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'router.post("/auth/wordpress/generate-key", requireBackendAuth, generateIntegrationKey)',
    );
    expect(source).toContain(
      'router.delete("/auth/wordpress/revoke-key", requireBackendAuth, revokeIntegrationKey)',
    );
  });

  it("rejects controller access without authenticated identity", async () => {
    const response = createMockResponse();

    await generateIntegrationKey(request({ businessId: BUSINESS_ID }), response);

    expect(response.statusCode).toBe(401);
    expect(businessFindFirstMock).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied user identity", async () => {
    const response = createMockResponse();

    await generateIntegrationKey(
      request(
        { businessId: BUSINESS_ID, userId: "spoofed-user" },
        "auth-user",
      ),
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(businessFindFirstMock).not.toHaveBeenCalled();
  });

  it("refuses cross-account business key generation", async () => {
    businessFindFirstMock.mockResolvedValue(null);
    const response = createMockResponse();

    await generateIntegrationKey(
      request({ businessId: BUSINESS_ID }, "auth-user"),
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(integrationUpsertMock).not.toHaveBeenCalled();
  });

  it("generates a 256-bit opaque WordPress credential for the owned business", async () => {
    businessFindFirstMock.mockResolvedValue({ id: BUSINESS_ID });
    integrationFindFirstMock.mockResolvedValue(null);
    integrationUpsertMock.mockImplementation(async (input) => ({
      id: INTEGRATION_ID,
      isActive: true,
      userId: input.create.userId,
      businessId: input.create.businessId,
    }));
    integrationUpdateMock.mockImplementation(async (input) => ({
      id: INTEGRATION_ID,
      isActive: true,
      userId: "auth-user",
      businessId: BUSINESS_ID,
      wordpressIntegrationKeyCreatedAt: new Date(),
      ...input.data,
    }));
    integrationFindUniqueMock.mockImplementation(async () => {
      const stored = integrationUpdateMock.mock.calls[0]?.[0]?.data;
      return {
        wordpressIntegrationKey: stored?.wordpressIntegrationKey,
        wordpressIntegrationKeyDigest: stored?.wordpressIntegrationKeyDigest,
      };
    });
    const response = createMockResponse();

    await generateIntegrationKey(
      request({ businessId: BUSINESS_ID }, "auth-user"),
      response,
    );

    expect(response.statusCode).toBe(200);
    const input = integrationUpsertMock.mock.calls[0]?.[0];
    const key = response.body.data?.integrationKey as string;
    const stored = integrationUpdateMock.mock.calls[0]?.[0]?.data;
    expect(key).toMatch(
      new RegExp(`^wp_key_v2_${INTEGRATION_ID.replaceAll("-", "\\-")}\\.[A-Za-z0-9_-]{43}$`),
    );
    expect(stored.wordpressIntegrationKey).not.toBe(key);
    expect(stored.wordpressIntegrationKey).toStartWith(
      "uai_secret_v2:wordpress-integration-key:",
    );
    expect(stored.wordpressIntegrationKeyDigest).toStartWith(
      "hmac-sha256:wp:v2:",
    );
    expect(input.create.userId).toBe("auth-user");
    expect(input.create.businessId).toBe(BUSINESS_ID);
    expect(response.body.data?.integrationKey).toBe(key);
  });

  it("revokes only the selected owned business key", async () => {
    businessFindFirstMock.mockResolvedValue({ id: BUSINESS_ID });
    integrationUpdateManyMock.mockResolvedValue({ count: 1 });
    const response = createMockResponse();

    await revokeIntegrationKey(
      request({ businessId: BUSINESS_ID }, "auth-user"),
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(integrationUpdateManyMock).toHaveBeenCalledWith({
      where: {
        userId: "auth-user",
        businessId: BUSINESS_ID,
        platform: "WORDPRESS",
      },
      data: {
        wordpressIntegrationKey: null,
        isActive: false,
        wordpressIntegrationKeyRevokedAt: expect.any(Date),
      },
    });
  });

  it("returns the same generic response for missing, unknown, and site-mismatched keys", async () => {
    const missingResponse = createMockResponse();
    await validateIntegrationKey(request({}), missingResponse);

    integrationFindUniqueMock.mockResolvedValue(null);
    integrationFindFirstMock.mockResolvedValue(null);
    const unknownResponse = createMockResponse();
    await validateIntegrationKey(
      request({
        integrationKey: "wp_key_v2_unknown",
        wordpressSiteUrl: "https://example.com",
      }),
      unknownResponse,
    );

    integrationFindFirstMock.mockResolvedValue({
      id: INTEGRATION_ID,
      userId: "auth-user",
      businessId: BUSINESS_ID,
      platform: "WORDPRESS",
      isActive: true,
      wordpressUrl: "https://example.com",
      autoPublish: true,
      publishAs: "PUBLISH",
    });
    const mismatchResponse = createMockResponse();
    await validateIntegrationKey(
      request({
        integrationKey: "wp_key_v2_existing",
        wordpressSiteUrl: "https://attacker.example",
      }),
      mismatchResponse,
    );

    for (const response of [
      missingResponse,
      unknownResponse,
      mismatchResponse,
    ]) {
      expect(response.statusCode).toBe(401);
      expect(response.body.message).toBe("Invalid credentials");
      expect(response.body.error).toBeUndefined();
    }
  });

  it("does not reveal whether a WordPress webhook credential exists", async () => {
    const missingResponse = createMockResponse();
    await handleWordPressWebhook(
      {
        body: { event: "post.updated", data: { post_id: "post-1" } },
        headers: {},
      } as never,
      missingResponse,
    );

    integrationFindFirstMock.mockResolvedValue(null);
    const unknownResponse = createMockResponse();
    await handleWordPressWebhook(
      {
        body: { event: "post.updated", data: { post_id: "post-1" } },
        headers: {
          authorization: "Bearer wp_key_v2_unknown",
          "x-wordpress-site": "https://example.com",
        },
      } as never,
      unknownResponse,
    );

    for (const response of [missingResponse, unknownResponse]) {
      expect(response.statusCode).toBe(401);
      expect(response.body.message).toBe("Invalid credentials");
      expect(response.body.error).toBeUndefined();
    }
  });
});
