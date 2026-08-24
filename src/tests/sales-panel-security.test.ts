import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";

const userFindUniqueMock = mock();
const assignmentFindFirstMock = mock();
const noteCreateMock = mock();
const saleCreateMock = mock();
const readTenantCacheMock = mock();
const writeTenantCacheMock = mock();
const invalidateTenantCacheMock = mock();

mock.module("../config/db.config", () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    salesCustomerAssignment: { findFirst: assignmentFindFirstMock },
    salesCustomerNote: { create: noteCreateMock },
    salesEntry: { create: saleCreateMock },
  },
}));

mock.module("../utils/tenant-response-cache", () => ({
  readTenantCache: readTenantCacheMock,
  writeTenantCache: writeTenantCacheMock,
  invalidateTenantCache: invalidateTenantCacheMock,
}));

const { requireSalesAccess } = await import("../middleware/require-sales-access");
const { createSalesEntry, createSalesNote, getSalesDashboard } = await import(
  "../controllers/sales-panel.controller"
);

function response() {
  const value = {
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
  return value as unknown as Response & {
    statusCode: number;
    body: { success: boolean; message: string };
  };
}

describe("sales panel backend security", () => {
  beforeEach(() => {
    userFindUniqueMock.mockReset();
    assignmentFindFirstMock.mockReset();
    noteCreateMock.mockReset();
    saleCreateMock.mockReset();
    readTenantCacheMock.mockReset();
    writeTenantCacheMock.mockReset();
    invalidateTenantCacheMock.mockReset();
  });

  it("wires the surface-bound backend sales session before routes", () => {
    const source = readFileSync(
      new URL("../routes/sales-panel.routes.ts", import.meta.url),
      "utf8",
    );
    const authIndex = source.indexOf("SalesPanelRouter.use(requireSalesSession)");
    const firstRouteIndex = source.indexOf("SalesPanelRouter.get(");
    expect(authIndex).toBeGreaterThan(-1);
    expect(firstRouteIndex).toBeGreaterThan(authIndex);
  });

  it("rejects disabled, missing, and non-sales identities", async () => {
    const next = mock() as unknown as NextFunction;
    for (const user of [
      null,
      { role: "USER", commandPanelEnabled: true },
      { role: "SALES", commandPanelEnabled: false },
    ]) {
      userFindUniqueMock.mockResolvedValueOnce(user);
      const res = response();
      await requireSalesAccess(
        { authUserId: "caller" } as Request,
        res,
        next,
      );
      expect(res.statusCode).toBe(403);
    }
    expect(next).not.toHaveBeenCalled();
  });

  it("admits only an enabled SALES identity loaded from backend truth", async () => {
    userFindUniqueMock.mockResolvedValue({
      role: "SALES",
      commandPanelEnabled: true,
    });
    const req = { authUserId: "caller" } as Request;
    const res = response();
    const next = mock() as unknown as NextFunction;
    await requireSalesAccess(req, res, next);
    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "caller" },
      select: { role: true, commandPanelEnabled: true },
    });
    expect(req.userRole).toBe("SALES");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects caller-supplied identity fields on notes", async () => {
    const res = response();
    await createSalesNote(
      {
        authUserId: "caller",
        params: { assignmentId: "assignment-a" },
        body: { body: "Follow up", salespersonId: "victim" },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(assignmentFindFirstMock).not.toHaveBeenCalled();
    expect(noteCreateMock).not.toHaveBeenCalled();
  });

  it("serves only the authenticated salesperson's scoped Redis dashboard read", async () => {
    const cached = {
      customerCount: 2,
      saleCount: 3,
      totalCents: 45_00,
      recentSales: [],
      recentCustomers: [],
    };
    readTenantCacheMock.mockResolvedValue(cached);
    const res = response();
    await getSalesDashboard({ authUserId: "caller" } as Request, res);
    expect(readTenantCacheMock).toHaveBeenCalledWith({
      namespace: "sales-dashboard",
      userId: "caller",
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as unknown as { data: unknown }).data).toEqual(cached);
  });

  it("scopes note ownership checks to the authenticated salesperson", async () => {
    assignmentFindFirstMock.mockResolvedValue(null);
    const res = response();
    await createSalesNote(
      {
        authUserId: "caller",
        params: { assignmentId: "assignment-a" },
        body: { body: "Follow up" },
      } as unknown as Request,
      res,
    );
    expect(assignmentFindFirstMock).toHaveBeenCalledWith({
      where: { id: "assignment-a", salespersonId: "caller" },
      select: { id: true },
    });
    expect(res.statusCode).toBe(404);
    expect(noteCreateMock).not.toHaveBeenCalled();
  });

  it("invalidates the salesperson read revision after a successful note write", async () => {
    assignmentFindFirstMock.mockResolvedValue({ id: "assignment-a" });
    noteCreateMock.mockResolvedValue({
      id: "note-a",
      body: "Follow up",
      createdAt: new Date("2026-08-15T00:00:00.000Z"),
    });
    const res = response();
    await createSalesNote(
      {
        authUserId: "caller",
        params: { assignmentId: "assignment-a" },
        body: { body: "Follow up" },
      } as unknown as Request,
      res,
    );
    expect(invalidateTenantCacheMock).toHaveBeenCalledWith("caller");
    expect(res.statusCode).toBe(201);
  });

  it("rejects caller-supplied identity fields on sales entries", async () => {
    const res = response();
    await createSalesEntry(
      {
        authUserId: "caller",
        params: { assignmentId: "assignment-a" },
        body: {
          itemSold: "Annual plan",
          soldTo: "Client",
          amount: 100,
          salespersonId: "victim",
        },
      } as unknown as Request,
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(assignmentFindFirstMock).not.toHaveBeenCalled();
    expect(saleCreateMock).not.toHaveBeenCalled();
  });
});
