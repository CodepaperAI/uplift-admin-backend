import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import type { Response } from "express";

const businessFindFirstMock = mock();
const apiTokenCreateMock = mock();
const apiTokenDeleteMock = mock();
const apiTokenFindFirstMock = mock();
const apiTokenFindManyMock = mock();
const apiTokenUpdateMock = mock();
const transactionMock = mock();

mock.module("../config/db.config", () => ({
  prisma: {
    business: { findFirst: businessFindFirstMock },
    apiToken: {
      create: apiTokenCreateMock,
      delete: apiTokenDeleteMock,
      findFirst: apiTokenFindFirstMock,
      findMany: apiTokenFindManyMock,
      update: apiTokenUpdateMock,
    },
    $transaction: transactionMock,
  },
}));

const {
  createApiToken,
  deleteApiToken,
  listApiTokens,
  regenerateApiToken,
} = await import("../controllers/api-token.controller");

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "22222222-2222-4222-8222-222222222222";
const originalHmacSecret = process.env.API_TOKEN_HMAC_SECRET;

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
    body: { success: boolean; message: string; data?: Record<string, unknown> };
  };
}

function request(body: Record<string, unknown>, authUserId?: string) {
  return { body, authUserId } as never;
}

describe("API token authorization", () => {
  beforeEach(() => {
    process.env.API_TOKEN_HMAC_SECRET =
      "test-api-token-hmac-secret-material-32-bytes-minimum";
    businessFindFirstMock.mockReset();
    apiTokenCreateMock.mockReset();
    apiTokenDeleteMock.mockReset();
    apiTokenFindFirstMock.mockReset();
    apiTokenFindManyMock.mockReset();
    apiTokenUpdateMock.mockReset();
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (callback) =>
      callback({
        apiToken: {
          create: apiTokenCreateMock,
          update: apiTokenUpdateMock,
        },
      }),
    );
  });

  afterAll(() => {
    if (originalHmacSecret === undefined) {
      delete process.env.API_TOKEN_HMAC_SECRET;
    } else {
      process.env.API_TOKEN_HMAC_SECRET = originalHmacSecret;
    }
  });

  it("wires backend authentication before every API token route", () => {
    const source = readFileSync(
      new URL("../routes/api-token.routes.ts", import.meta.url),
      "utf8",
    );
    const authIndex = source.indexOf("ApiTokenRouter.use(requireBackendAuth)");
    const firstRouteIndex = source.indexOf("ApiTokenRouter.post(");

    expect(authIndex).toBeGreaterThan(-1);
    expect(firstRouteIndex).toBeGreaterThan(authIndex);
  });

  it("rejects a controller call without authenticated identity", async () => {
    const response = createMockResponse();

    await listApiTokens(request({ businessId: BUSINESS_ID }), response);

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe("Unauthorized");
    expect(businessFindFirstMock).not.toHaveBeenCalled();
    expect(apiTokenFindManyMock).not.toHaveBeenCalled();
  });

  it("rejects legacy caller-supplied userId fields", async () => {
    const response = createMockResponse();

    await listApiTokens(
      request({ businessId: BUSINESS_ID, userId: "spoofed-user" }, "auth-user"),
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.success).toBe(false);
    expect(businessFindFirstMock).not.toHaveBeenCalled();
  });

  it("checks list access against the authenticated owner", async () => {
    businessFindFirstMock.mockResolvedValue({ id: BUSINESS_ID });
    apiTokenFindManyMock.mockResolvedValue([]);
    const response = createMockResponse();

    await listApiTokens(
      request({ businessId: BUSINESS_ID }, "auth-user"),
      response,
    );

    expect(businessFindFirstMock).toHaveBeenCalledWith({
      where: { id: BUSINESS_ID, userId: "auth-user", isActive: true },
      select: { id: true },
    });
    expect(apiTokenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "auth-user", businessId: BUSINESS_ID },
      }),
    );
    expect(response.statusCode).toBe(200);
  });

  it("refuses to list tokens for a business owned by another user", async () => {
    businessFindFirstMock.mockResolvedValue(null);
    const response = createMockResponse();

    await listApiTokens(
      request({ businessId: BUSINESS_ID }, "auth-user"),
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(apiTokenFindManyMock).not.toHaveBeenCalled();
  });

  it("creates a scoped, expiring token for the authenticated owner", async () => {
    businessFindFirstMock.mockResolvedValue({
      id: BUSINESS_ID,
      businessWebsiteUrl: "https://example.com",
      businessName: "Example",
    });
    apiTokenCreateMock.mockResolvedValue({
      id: TOKEN_ID,
      name: "CMS",
      tokenPrefix: "uai_example",
      permissions: ["read:blogs", "read:keywords"],
      isActive: true,
      expiresAt: new Date(),
      createdAt: new Date(),
      business: { id: BUSINESS_ID, businessName: "Example" },
    });
    const response = createMockResponse();

    await createApiToken(
      request({ businessId: BUSINESS_ID, name: " CMS " }, "auth-user"),
      response,
    );

    expect(apiTokenCreateMock).toHaveBeenCalledTimes(1);
    const createInput = apiTokenCreateMock.mock.calls[0]?.[0];
    expect(createInput.data.userId).toBe("auth-user");
    expect(createInput.data.businessId).toBe(BUSINESS_ID);
    expect(createInput.data.name).toBe("CMS");
    expect(createInput.data.permissions).toEqual(["read:blogs", "read:keywords"]);
    expect(createInput.data.expiresAt).toBeInstanceOf(Date);
    expect(createInput.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(createInput.data.token).toStartWith("hmac-sha256:v2:");
    expect(response.body.data?.plainToken).toStartWith(
      `uai_v2_${createInput.data.id}.`,
    );
    expect(String(response.body.data?.plainToken)).not.toContain(
      createInput.data.token,
    );
  });

  it("fails closed when the token HMAC secret is unavailable", async () => {
    delete process.env.API_TOKEN_HMAC_SECRET;
    businessFindFirstMock.mockResolvedValue({
      id: BUSINESS_ID,
      businessWebsiteUrl: "https://example.com",
      businessName: "Example",
    });
    const response = createMockResponse();

    await createApiToken(
      request({ businessId: BUSINESS_ID, name: "CMS" }, "auth-user"),
      response,
    );

    expect(response.statusCode).toBe(503);
    expect(apiTokenCreateMock).not.toHaveBeenCalled();
  });

  it("uses authenticated ownership for deletion", async () => {
    apiTokenFindFirstMock.mockResolvedValue(null);
    const response = createMockResponse();

    await deleteApiToken(
      request({ tokenId: TOKEN_ID }, "auth-user"),
      response,
    );

    expect(apiTokenFindFirstMock).toHaveBeenCalledWith({
      where: { id: TOKEN_ID, userId: "auth-user" },
    });
    expect(response.statusCode).toBe(404);
    expect(apiTokenDeleteMock).not.toHaveBeenCalled();
  });

  it("rotates tokens atomically and removes unsupported legacy scopes", async () => {
    apiTokenFindFirstMock.mockResolvedValue({
      id: TOKEN_ID,
      userId: "auth-user",
      businessId: BUSINESS_ID,
      name: "Legacy",
      permissions: ["read:blogs", "admin:anything"],
    });
    businessFindFirstMock.mockResolvedValue({
      id: BUSINESS_ID,
      businessWebsiteUrl: "https://example.com",
    });
    apiTokenCreateMock.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Legacy",
      tokenPrefix: "uai_rotated",
      permissions: ["read:blogs"],
      isActive: true,
      expiresAt: new Date(),
      createdAt: new Date(),
      business: { id: BUSINESS_ID, businessName: "Example" },
    });
    const response = createMockResponse();

    await regenerateApiToken(
      request({ tokenId: TOKEN_ID }, "auth-user"),
      response,
    );

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(apiTokenUpdateMock).toHaveBeenCalledWith({
      where: { id: TOKEN_ID },
      data: {
        isActive: false,
        revokedAt: expect.any(Date),
        revocationReason: "rotated",
      },
    });
    expect(apiTokenCreateMock.mock.calls[0]?.[0].data.rotatedFromTokenId).toBe(
      TOKEN_ID,
    );
    expect(apiTokenCreateMock.mock.calls[0]?.[0].data.permissions).toEqual([
      "read:blogs",
    ]);
    expect(response.statusCode).toBe(200);
  });
});
