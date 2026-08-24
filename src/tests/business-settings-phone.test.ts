import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

const findFirstMock = mock(async () => ({ id: BUSINESS_ID }));
const updateMock = mock(async ({ data }: { data: Record<string, unknown> }) => ({
  id: BUSINESS_ID,
  ...data,
}));
const invalidateTenantCacheMock = mock(async () => undefined);

mock.module("../config/db.config", () => ({
  prisma: {
    business: {
      findFirst: findFirstMock,
      update: updateMock,
    },
  },
}));

mock.module("../utils/tenant-response-cache", () => ({
  invalidateTenantCache: invalidateTenantCacheMock,
  readTenantCache: mock(async () => null),
  writeTenantCache: mock(async () => undefined),
}));

let updateBusinessBasicSettings: typeof import("../controllers/business-settings.controller").updateBusinessBasicSettings;

beforeAll(async () => {
  ({ updateBusinessBasicSettings } = await import(
    "../controllers/business-settings.controller"
  ));
});

beforeEach(() => {
  findFirstMock.mockClear();
  updateMock.mockClear();
  invalidateTenantCacheMock.mockClear();
});

function request(body: Record<string, unknown>) {
  return {
    authUserId: "user-1",
    body: {
      businessId: BUSINESS_ID,
      businessName: "Example Business",
      businessType: "Consulting",
      businessDescription: "Practical consulting services.",
      businessWebsiteUrl: "https://example.com",
      ...body,
    },
  } as never;
}

function response() {
  const result = {
    statusCode: 200,
    payload: null as unknown,
  };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      result.payload = payload;
      return res;
    },
  };
  return { res: res as never, result };
}

describe("business profile mobile number", () => {
  it("normalizes and persists an international mobile number", async () => {
    const { res, result } = response();

    await updateBusinessBasicSettings(
      request({ businessPhone: "+1 (416) 555-0123" }),
      res,
    );

    expect(result.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]?.[0]).toMatchObject({
      where: { id: BUSINESS_ID },
      data: { businessPhone: "+14165550123" },
    });
    expect(invalidateTenantCacheMock).toHaveBeenCalledWith(
      "user-1",
      BUSINESS_ID,
    );
  });

  it("clears the selected business mobile number when submitted empty", async () => {
    const { res, result } = response();

    await updateBusinessBasicSettings(request({ businessPhone: "" }), res);

    expect(result.statusCode).toBe(200);
    expect(updateMock.mock.calls[0]?.[0]).toMatchObject({
      data: { businessPhone: null },
    });
  });

  it("preserves the stored number for older clients that omit the field", async () => {
    const { res, result } = response();

    await updateBusinessBasicSettings(request({}), res);

    expect(result.statusCode).toBe(200);
    const updateData = updateMock.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(updateData, "businessPhone")).toBe(false);
  });

  it("rejects an invalid number before writing to the database", async () => {
    const { res, result } = response();

    await updateBusinessBasicSettings(
      request({ businessPhone: "416-55" }),
      res,
    );

    expect(result.statusCode).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.payload).toMatchObject({
      success: false,
      message:
        "businessPhone: Enter a valid mobile number including its country code",
    });
  });
});
