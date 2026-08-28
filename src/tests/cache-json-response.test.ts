import { beforeEach, describe, expect, it, mock } from "bun:test";

const readTenantCache = mock(async (_input: unknown) => null as unknown);
const writeTenantCache = mock(async (_input: unknown) => undefined);

mock.module("../utils/tenant-response-cache", () => ({
  readTenantCache,
  writeTenantCache,
}));

const { cacheJsonResponse } = await import("../middleware/cache-json-response");

type FakeRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  jsonCalls: number;
  setHeader(name: string, value: string): void;
  json(body: unknown): FakeRes;
};

function makeRes(statusCode = 200): FakeRes {
  const res: FakeRes = {
    statusCode,
    headers: {},
    body: undefined,
    jsonCalls: 0,
    setHeader(name, value) {
      res.headers[name] = value;
    },
    json(body) {
      res.jsonCalls += 1;
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeReq(method: string, originalUrl: string) {
  return { method, originalUrl } as never;
}

beforeEach(() => {
  readTenantCache.mockReset();
  writeTenantCache.mockReset();
  readTenantCache.mockResolvedValue(null);
  writeTenantCache.mockResolvedValue(undefined);
});

describe("cacheJsonResponse", () => {
  it("serves a hit without calling the handler", async () => {
    readTenantCache.mockResolvedValue({ success: true, data: { cached: true } });
    const middleware = cacheJsonResponse({ name: "overview", ttlSeconds: 90 });
    const res = makeRes();
    let nextCalled = false;
    await middleware(makeReq("GET", "/api/v1/superadmin/agencies/metrics/overview"), res as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.headers["X-Cache"]).toBe("hit");
    expect(res.body).toEqual({ success: true, data: { cached: true } });
  });

  it("stores a 200 and marks the response a miss", async () => {
    const middleware = cacheJsonResponse({ name: "overview", ttlSeconds: 90 });
    const res = makeRes(200);
    await middleware(makeReq("GET", "/metrics/overview?from=2026-08-01"), res as never, () => {});
    res.json({ success: true, data: { total: 3 } });
    expect(res.headers["X-Cache"]).toBe("miss");
    expect(writeTenantCache).toHaveBeenCalledTimes(1);
    const call = writeTenantCache.mock.calls[0]?.[0] as {
      namespace: string;
      value: unknown;
      ttlSeconds: number;
    };
    expect(call.value).toEqual({ success: true, data: { total: 3 } });
    expect(call.ttlSeconds).toBe(90);
    expect(call.namespace).toContain("/metrics/overview?from=2026-08-01");
  });

  it("never stores a non-200", async () => {
    // Pinning a 500 or a 403 for the TTL would turn one bad moment into ninety
    // seconds of a wrong answer served from cache.
    for (const status of [400, 403, 404, 500, 503]) {
      writeTenantCache.mockClear();
      const middleware = cacheJsonResponse({ name: "overview", ttlSeconds: 90 });
      const res = makeRes(status);
      await middleware(makeReq("GET", "/metrics/overview"), res as never, () => {});
      res.json({ success: false, error: "nope" });
      expect(writeTenantCache).not.toHaveBeenCalled();
    }
  });

  it("keys different query strings separately", async () => {
    const middleware = cacheJsonResponse({ name: "overview", ttlSeconds: 90 });
    for (const url of ["/metrics/overview?from=a", "/metrics/overview?from=b"]) {
      const res = makeRes();
      await middleware(makeReq("GET", url), res as never, () => {});
      res.json({ url });
    }
    const namespaces = writeTenantCache.mock.calls.map(
      (call) => (call[0] as { namespace: string }).namespace,
    );
    expect(new Set(namespaces).size).toBe(2);
  });

  it("passes a non-GET straight through and caches nothing", async () => {
    const middleware = cacheJsonResponse({ name: "overview", ttlSeconds: 90 });
    const res = makeRes();
    let nextCalled = false;
    await middleware(makeReq("POST", "/metrics/overview"), res as never, () => {
      nextCalled = true;
    });
    res.json({ ok: true });
    expect(nextCalled).toBe(true);
    expect(readTenantCache).not.toHaveBeenCalled();
    expect(writeTenantCache).not.toHaveBeenCalled();
  });

  it("still answers when the cache read fails", async () => {
    // tenant-response-cache swallows Redis faults and returns null; the request
    // must proceed to the handler rather than surfacing an error.
    readTenantCache.mockResolvedValue(null);
    const middleware = cacheJsonResponse({ name: "overview", ttlSeconds: 90 });
    const res = makeRes();
    let nextCalled = false;
    await middleware(makeReq("GET", "/metrics/overview"), res as never, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers["X-Cache"]).toBe("miss");
  });
});
