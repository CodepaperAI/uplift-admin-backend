import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "../utils/tenant-response-cache";

const SALES_DASHBOARD_CACHE_NAMESPACE = "sales-dashboard";
const SALES_ASSIGNMENTS_CACHE_NAMESPACE = "sales-assignments";
const SALES_READ_CACHE_TTL_SECONDS = 60;

type SalesDashboardPayload = {
  customerCount: number;
  saleCount: number;
  totalCents: number;
  recentSales: unknown[];
  recentCustomers: unknown[];
};

type SalesAssignmentsPayload = {
  assignments: unknown[];
};

const ASSIGN_CUSTOMER = z.object({
  businessId: z.string().min(1).max(128),
}).strict();
const CREATE_NOTE = z.object({
  body: z.string().trim().min(1).max(2_000),
}).strict();
const CREATE_SALE = z.object({
  itemSold: z.string().trim().min(1).max(150),
  soldTo: z.string().trim().min(1).max(150),
  amount: z.union([z.number(), z.string()]),
}).strict();

function salespersonId(req: Request, res: Response): string | null {
  if (!req.authUserId) {
    sendError(res, "Unauthorized", 401);
    return null;
  }
  return req.authUserId;
}

function eligibleCustomerWhere() {
  return {
    removalStatus: { not: "removed" },
    User: { role: { notIn: ["ADMIN", "SUPERADMIN", "SALES"] } },
    OR: [
      { onboardingStatus: "completed" },
      { onboardingCompletedAt: { not: null } },
      { User: { onboarding: true } },
    ],
  } satisfies Prisma.BusinessWhereInput;
}

export async function getSalesDashboard(req: Request, res: Response) {
  const userId = salespersonId(req, res);
  if (!userId) return;
  try {
    const cached = await readTenantCache<SalesDashboardPayload>({
      namespace: SALES_DASHBOARD_CACHE_NAMESPACE,
      userId,
    });
    if (cached) return sendSuccess(res, cached);

    const [customerCount, saleSummary, recentSales, recentCustomers] =
      await Promise.all([
        prisma.salesCustomerAssignment.count({ where: { salespersonId: userId } }),
        prisma.salesEntry.aggregate({
          where: { salespersonId: userId },
          _count: { _all: true },
          _sum: { amountCents: true },
        }),
        prisma.salesEntry.findMany({
          where: { salespersonId: userId },
          orderBy: { soldAt: "desc" },
          take: 8,
          select: {
            id: true,
            itemSold: true,
            amountCents: true,
            currency: true,
            soldTo: true,
            soldAt: true,
            assignment: {
              select: { business: { select: { businessName: true } } },
            },
          },
        }),
        prisma.salesCustomerAssignment.findMany({
          where: { salespersonId: userId },
          orderBy: { assignedAt: "desc" },
          take: 6,
          select: {
            id: true,
            assignedAt: true,
            business: {
              select: {
                businessName: true,
                businessWebsiteUrl: true,
                User: { select: { name: true, email: true } },
              },
            },
            _count: { select: { notes: true, sales: true } },
            sales: { select: { amountCents: true } },
          },
        }),
      ]);
    const payload: SalesDashboardPayload = {
      customerCount,
      saleCount: saleSummary._count._all,
      totalCents: saleSummary._sum.amountCents ?? 0,
      recentSales,
      recentCustomers,
    };
    await writeTenantCache({
      namespace: SALES_DASHBOARD_CACHE_NAMESPACE,
      userId,
      value: payload,
      ttlSeconds: SALES_READ_CACHE_TTL_SECONDS,
    });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, "Sales dashboard could not be loaded", 500, error);
  }
}

export async function getSalesAssignments(req: Request, res: Response) {
  const userId = salespersonId(req, res);
  if (!userId) return;
  try {
    const cached = await readTenantCache<SalesAssignmentsPayload>({
      namespace: SALES_ASSIGNMENTS_CACHE_NAMESPACE,
      userId,
    });
    if (cached) return sendSuccess(res, cached);

    const assignments = await prisma.salesCustomerAssignment.findMany({
      where: { salespersonId: userId },
      orderBy: { assignedAt: "desc" },
      select: {
        id: true,
        assignedAt: true,
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            businessPhone: true,
            businessCity: true,
            businessState: true,
            onboardingStatus: true,
            User: { select: { id: true, name: true, email: true } },
          },
        },
        notes: {
          orderBy: { createdAt: "desc" },
          select: { id: true, body: true, createdAt: true },
        },
        sales: {
          orderBy: { soldAt: "desc" },
          select: {
            id: true,
            itemSold: true,
            amountCents: true,
            currency: true,
            soldTo: true,
            soldAt: true,
          },
        },
      },
    });
    const payload: SalesAssignmentsPayload = { assignments };
    await writeTenantCache({
      namespace: SALES_ASSIGNMENTS_CACHE_NAMESPACE,
      userId,
      value: payload,
      ttlSeconds: SALES_READ_CACHE_TTL_SECONDS,
    });
    return sendSuccess(res, payload);
  } catch (error) {
    return sendError(res, "Customers could not be loaded", 500, error);
  }
}

export async function searchSalesCustomers(req: Request, res: Response) {
  const userId = salespersonId(req, res);
  if (!userId) return;
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 2 || query.length > 200) {
    return sendSuccess(res, { items: [] });
  }
  try {
    const businesses = await prisma.business.findMany({
      where: {
        AND: [
          eligibleCustomerWhere(),
          {
            OR: [
              { businessName: { contains: query, mode: "insensitive" } },
              { businessWebsiteUrl: { contains: query, mode: "insensitive" } },
              { businessPhone: { contains: query, mode: "insensitive" } },
              { User: { name: { contains: query, mode: "insensitive" } } },
              { User: { email: { contains: query, mode: "insensitive" } } },
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        businessName: true,
        businessWebsiteUrl: true,
        businessPhone: true,
        businessCity: true,
        businessState: true,
        onboardingStatus: true,
        User: { select: { name: true, email: true } },
        SalesCustomerAssignment: { select: { id: true, salespersonId: true } },
      },
    });
    return sendSuccess(res, {
      items: businesses.map((business) => ({
        id: business.id,
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
        businessPhone: business.businessPhone,
        businessCity: business.businessCity,
        businessState: business.businessState,
        onboardingStatus: business.onboardingStatus,
        ownerName: business.User.name,
        ownerEmail: business.User.email,
        assignmentStatus: business.SalesCustomerAssignment
          ? business.SalesCustomerAssignment.salespersonId === userId
            ? "mine"
            : "assigned"
          : "available",
      })),
    });
  } catch (error) {
    return sendError(res, "Customer search could not be completed", 500, error);
  }
}

export async function assignSalesCustomer(req: Request, res: Response) {
  const userId = salespersonId(req, res);
  if (!userId) return;
  const parsed = ASSIGN_CUSTOMER.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid request", 400);
  try {
    const business = await prisma.business.findFirst({
      where: { id: parsed.data.businessId, ...eligibleCustomerWhere() },
      select: { id: true },
    });
    if (!business) return sendError(res, "Customer not found", 404);
    const existing = await prisma.salesCustomerAssignment.findUnique({
      where: { businessId: business.id },
      select: { id: true, salespersonId: true },
    });
    if (existing) {
      return existing.salespersonId === userId
        ? sendSuccess(res, { assignment: existing })
        : sendError(res, "Customer is already assigned", 409);
    }
    const assignment = await prisma.salesCustomerAssignment.create({
      data: { businessId: business.id, salespersonId: userId },
      select: { id: true, businessId: true, assignedAt: true },
    });
    await invalidateTenantCache(userId);
    return sendSuccess(res, { assignment }, "Customer assigned", 201);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return sendError(res, "Customer is already assigned", 409);
    }
    return sendError(res, "Customer could not be assigned", 500, error);
  }
}

async function ownedAssignment(assignmentId: string, userId: string) {
  return prisma.salesCustomerAssignment.findFirst({
    where: { id: assignmentId, salespersonId: userId },
    select: { id: true },
  });
}

export async function createSalesNote(req: Request, res: Response) {
  const userId = salespersonId(req, res);
  if (!userId) return;
  const parsed = CREATE_NOTE.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid note", 400);
  const assignmentId = req.params.assignmentId;
  if (!assignmentId) return sendError(res, "Invalid request", 400);
  const assignment = await ownedAssignment(assignmentId, userId);
  if (!assignment) return sendError(res, "Customer not found", 404);
  try {
    const note = await prisma.salesCustomerNote.create({
      data: { assignmentId: assignment.id, authorUserId: userId, body: parsed.data.body },
      select: { id: true, body: true, createdAt: true },
    });
    await invalidateTenantCache(userId);
    return sendSuccess(res, { note }, "Note created", 201);
  } catch (error) {
    return sendError(res, "Note could not be created", 500, error);
  }
}

export async function createSalesEntry(req: Request, res: Response) {
  const userId = salespersonId(req, res);
  if (!userId) return;
  const parsed = CREATE_SALE.safeParse(req.body);
  if (!parsed.success) return sendError(res, "Invalid sale", 400);
  const amountCents = Math.round(Number(parsed.data.amount) * 100);
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > 1_000_000_000
  ) {
    return sendError(res, "Invalid sale amount", 400);
  }
  const assignmentId = req.params.assignmentId;
  if (!assignmentId) return sendError(res, "Invalid request", 400);
  const assignment = await ownedAssignment(assignmentId, userId);
  if (!assignment) return sendError(res, "Customer not found", 404);
  try {
    const sale = await prisma.salesEntry.create({
      data: {
        assignmentId: assignment.id,
        salespersonId: userId,
        itemSold: parsed.data.itemSold,
        amountCents,
        soldTo: parsed.data.soldTo,
      },
      select: {
        id: true,
        itemSold: true,
        amountCents: true,
        currency: true,
        soldTo: true,
        soldAt: true,
      },
    });
    await invalidateTenantCache(userId);
    return sendSuccess(res, { sale }, "Sale created", 201);
  } catch (error) {
    return sendError(res, "Sale could not be created", 500, error);
  }
}
