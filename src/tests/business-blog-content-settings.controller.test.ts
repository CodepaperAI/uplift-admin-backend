import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Response } from "express";

import { prisma } from "../config/db.config";
import {
  getBlogContentSettings,
  updateBlogContentSettings,
} from "../controllers/business-settings.controller";

const businessDelegate = prisma.business as unknown as {
  findFirst: typeof prisma.business.findFirst;
  update: typeof prisma.business.update;
};
const originalFindFirst = businessDelegate.findFirst;
const originalUpdate = businessDelegate.update;

function mockResponse() {
  let statusCode = 200;
  let body: any;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => body };
}

afterEach(() => {
  businessDelegate.findFirst = originalFindFirst;
  businessDelegate.update = originalUpdate;
});

describe("business blog content settings", () => {
  test("mounts both settings endpoints behind backend authentication", () => {
    const service = readFileSync(
      resolve(import.meta.dir, "../services/business.service.ts"),
      "utf8",
    );
    const auth = service.indexOf("BusinessRouter.use(requireBackendAuth)");
    const readRoute = service.indexOf(
      'BusinessRouter.post("/settings/blog-content"',
    );
    const updateRoute = service.indexOf(
      'BusinessRouter.post("/settings/blog-content/update"',
    );

    expect(auth).toBeGreaterThanOrEqual(0);
    expect(readRoute).toBeGreaterThan(auth);
    expect(updateRoute).toBeGreaterThan(auth);
  });

  test("requires authentication before reading a setting", async () => {
    let queried = false;
    businessDelegate.findFirst = (async () => {
      queried = true;
      return null;
    }) as typeof businessDelegate.findFirst;
    const response = mockResponse();

    await getBlogContentSettings(
      { body: { businessId: "61a2fa2e-5067-439b-a2d5-1415af758843" } } as never,
      response.res,
    );

    expect(response.status()).toBe(401);
    expect(queried).toBe(false);
  });

  test("returns only the owned website image policy", async () => {
    let findArgs: unknown;
    businessDelegate.findFirst = (async (args: unknown) => {
      findArgs = args;
      return {
        id: "61a2fa2e-5067-439b-a2d5-1415af758843",
        blogImagesEnabled: true,
      };
    }) as typeof businessDelegate.findFirst;
    const response = mockResponse();

    await getBlogContentSettings(
      {
        authUserId: "user-1",
        body: { businessId: "61a2fa2e-5067-439b-a2d5-1415af758843" },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(findArgs).toEqual({
      where: {
        id: "61a2fa2e-5067-439b-a2d5-1415af758843",
        userId: "user-1",
        isActive: true,
      },
      select: { id: true, blogImagesEnabled: true },
    });
    expect(response.body().data).toEqual({
      settings: {
        businessId: "61a2fa2e-5067-439b-a2d5-1415af758843",
        blogImagesEnabled: true,
      },
    });
  });

  test("persists a boolean policy only after ownership succeeds", async () => {
    businessDelegate.findFirst = (async () => ({
      id: "61a2fa2e-5067-439b-a2d5-1415af758843",
      blogImagesEnabled: true,
    })) as typeof businessDelegate.findFirst;
    let updateArgs: unknown;
    businessDelegate.update = (async (args: unknown) => {
      updateArgs = args;
      return {
        id: "61a2fa2e-5067-439b-a2d5-1415af758843",
        blogImagesEnabled: false,
      };
    }) as typeof businessDelegate.update;
    const response = mockResponse();

    await updateBlogContentSettings(
      {
        authUserId: "user-1",
        body: {
          businessId: "61a2fa2e-5067-439b-a2d5-1415af758843",
          blogImagesEnabled: false,
        },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(200);
    expect(updateArgs).toEqual({
      where: { id: "61a2fa2e-5067-439b-a2d5-1415af758843" },
      data: { blogImagesEnabled: false },
      select: { id: true, blogImagesEnabled: true },
    });
    expect(response.body().data.settings.blogImagesEnabled).toBe(false);
  });

  test("rejects string-like booleans without writing", async () => {
    let updated = false;
    businessDelegate.update = (async () => {
      updated = true;
      return null;
    }) as unknown as typeof businessDelegate.update;
    const response = mockResponse();

    await updateBlogContentSettings(
      {
        authUserId: "user-1",
        body: {
          businessId: "61a2fa2e-5067-439b-a2d5-1415af758843",
          blogImagesEnabled: "false",
        },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(400);
    expect(updated).toBe(false);
  });

  test("does not update a website outside the authenticated owner scope", async () => {
    businessDelegate.findFirst = (async () => null) as typeof businessDelegate.findFirst;
    let updated = false;
    businessDelegate.update = (async () => {
      updated = true;
      return null;
    }) as unknown as typeof businessDelegate.update;
    const response = mockResponse();

    await updateBlogContentSettings(
      {
        authUserId: "user-2",
        body: {
          businessId: "61a2fa2e-5067-439b-a2d5-1415af758843",
          blogImagesEnabled: false,
        },
      } as never,
      response.res,
    );

    expect(response.status()).toBe(404);
    expect(updated).toBe(false);
  });
});
