import type { Prisma } from "@prisma/client";
import type { Response } from "express";
import { z, ZodError } from "zod";
import { prisma } from "../config/db.config";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import {
  getAttributeById,
  getAttributesForCategoryIds,
  getRequiredAttributesForPrimaryCategory,
  listAllAttributes,
  validateAttributeSubmissions,
  type GMBAttributeSubmission,
} from "../utils/gmb-attributes";
import {
  getCategoryById,
  validateCategorySelection,
} from "../utils/gmb-categories";
import {
  DAY_NAMES,
  diffWeeklyHours,
  serializeForGbpPatch,
  validateBusinessHours,
  type GMBHoursSegment,
} from "../utils/gmb-hours";
import {
  handleValidationError,
  sendError,
  sendSuccess,
} from "../utils/response.utils";
import { invalidateTenantCache } from "../utils/tenant-response-cache";

const BUSINESS_QUERY = z.object({ businessId: z.string().uuid() }).strict();
const CATALOG_QUERY = z.object({ businessId: z.string().uuid().optional() }).strict();

const ATTRIBUTE_SUBMISSION = z.object({
  attributeId: z.string().trim().min(1).max(160),
  boolValue: z.boolean().nullable().optional(),
  enumValue: z.string().trim().max(160).nullable().optional(),
  urlValue: z.string().trim().max(2_048).nullable().optional(),
  enumValues: z.array(z.string().trim().max(160)).max(50).nullable().optional(),
}).strict();

const ATTRIBUTES_BODY = z.object({
  businessId: z.string().uuid(),
  attributes: z.array(ATTRIBUTE_SUBMISSION).max(100),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.attributes.forEach((attribute, index) => {
    if (seen.has(attribute.attributeId)) {
      context.addIssue({
        code: "custom",
        path: ["attributes", index, "attributeId"],
        message: "Duplicate attribute",
      });
    }
    seen.add(attribute.attributeId);
  });
});

const CATEGORIES_BODY = z.object({
  businessId: z.string().uuid(),
  primaryCategoryId: z.string().trim().min(1).max(200).nullable(),
  secondaryCategoryIds: z.array(z.string().trim().min(1).max(200)).max(9),
}).strict();

const TIME_VALUE = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable();
const HOURS_SEGMENT = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: TIME_VALUE,
  closeTime: TIME_VALUE,
  isClosed: z.boolean(),
  is24Hours: z.boolean(),
  segmentOrder: z.number().int().min(0).max(1),
}).strict();
const HOURS_BODY = z.object({
  businessId: z.string().uuid(),
  segments: z.array(HOURS_SEGMENT).max(14),
}).strict();

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const SPECIAL_HOURS_ENTRY = z.object({
  date: ISO_DATE,
  openTime: TIME_VALUE.optional().default(null),
  closeTime: TIME_VALUE.optional().default(null),
  isClosed: z.boolean().optional().default(false),
  is24Hours: z.boolean().optional().default(false),
  label: z.string().trim().max(160).nullable().optional().default(null),
}).strict();
const SPECIAL_HOURS_BODY = z.object({
  businessId: z.string().uuid(),
  entries: z.array(SPECIAL_HOURS_ENTRY).max(100),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (seen.has(entry.date)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "date"],
        message: "Duplicate date",
      });
    }
    seen.add(entry.date);
    if (entry.isClosed && (entry.openTime || entry.closeTime || entry.is24Hours)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index],
        message: "Closed dates cannot also contain open hours",
      });
    }
    if (!entry.isClosed && !entry.is24Hours && (!entry.openTime || !entry.closeTime)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index],
        message: "Open and close time are required",
      });
    }
    if (
      !entry.isClosed &&
      !entry.is24Hours &&
      entry.openTime &&
      entry.closeTime &&
      entry.closeTime !== "00:00" &&
      entry.closeTime <= entry.openTime
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "closeTime"],
        message: "Close time must be later than open time",
      });
    }
  });
});

async function requireOwnedBusiness(req: AuthenticatedRequest, businessId: string) {
  if (!req.authUserId) return null;
  return prisma.business.findFirst({
    where: { id: businessId, userId: req.authUserId, isActive: true },
    select: { id: true },
  });
}

async function requireConnectedGmb(req: AuthenticatedRequest, businessId: string) {
  const business = await requireOwnedBusiness(req, businessId);
  if (!business) return { business: null, gmb: null };
  const gmb = await prisma.googleMyBusiness.findUnique({
    where: { businessId },
    select: { id: true },
  });
  return { business, gmb };
}

type ActionInput = {
  businessId: string;
  gmbId: string;
  actionType: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  payloadJson: Prisma.InputJsonValue;
};

async function queuePendingUserEdit(input: ActionInput) {
  return prisma.$transaction(async (tx) => {
    // Serialize requests for the same tenant/action so double-clicks or
    // concurrent retries cannot create duplicate pending recommendations.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.businessId}:${input.actionType}:user_edit`}))`;
    const existing = await tx.gMBActionRecommendation.findFirst({
      where: {
        businessId: input.businessId,
        gmbId: input.gmbId,
        actionType: input.actionType,
        status: "PENDING",
        source: "user_edit",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const data = {
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      payloadJson: input.payloadJson,
    };
    if (existing) {
      return tx.gMBActionRecommendation.update({ where: { id: existing.id }, data });
    }
    return tx.gMBActionRecommendation.create({
      data: {
        ...data,
        businessId: input.businessId,
        gmbId: input.gmbId,
        actionType: input.actionType,
        status: "PENDING",
        source: "user_edit",
      },
    });
  });
}

function validationFailure(res: Response, error: unknown) {
  if (error instanceof ZodError) return handleValidationError(res, error);
  return sendError(res, "Request could not be completed", 500);
}

async function loadCurrentAttributes(businessId: string) {
  return prisma.gMBAttribute.findMany({
    where: { businessId },
    orderBy: { attributeId: "asc" },
    select: {
      attributeId: true,
      displayName: true,
      valueType: true,
      boolValue: true,
      enumValue: true,
      urlValue: true,
      enumValues: true,
    },
  });
}

async function loadCurrentCategories(businessId: string) {
  const rows = await prisma.gMBCategory.findMany({
    where: { businessId },
    orderBy: [{ isPrimary: "desc" }, { order: "asc" }, { createdAt: "asc" }],
    select: { categoryId: true, displayName: true, isPrimary: true },
  });
  const primary = rows.find((row) => row.isPrimary);
  return {
    primary: primary ? { id: primary.categoryId, name: primary.displayName } : null,
    secondary: rows
      .filter((row) => !row.isPrimary)
      .map((row) => ({ id: row.categoryId, name: row.displayName })),
  };
}

async function loadCurrentHours(businessId: string): Promise<GMBHoursSegment[]> {
  return prisma.gMBBusinessHours.findMany({
    where: { businessId },
    orderBy: [{ dayOfWeek: "asc" }, { segmentOrder: "asc" }],
    select: {
      dayOfWeek: true,
      openTime: true,
      closeTime: true,
      isClosed: true,
      is24Hours: true,
      segmentOrder: true,
    },
  });
}

type SimpleAttributeValue = {
  boolValue?: boolean | null;
  enumValue?: string | null;
  urlValue?: string | null;
  enumValues?: string[] | null;
};

function sameAttributeValue(left: SimpleAttributeValue, right: SimpleAttributeValue) {
  const leftEnums = (left.enumValues ?? []).slice().sort();
  const rightEnums = (right.enumValues ?? []).slice().sort();
  return (
    (left.boolValue ?? null) === (right.boolValue ?? null) &&
    (left.enumValue ?? null) === (right.enumValue ?? null) &&
    (left.urlValue ?? null) === (right.urlValue ?? null) &&
    leftEnums.length === rightEnums.length &&
    leftEnums.every((value, index) => value === rightEnums[index])
  );
}

function serializeAttributeValue(value: SimpleAttributeValue | null) {
  if (!value) return null;
  if (typeof value.boolValue === "boolean") return value.boolValue ? "Yes" : "No";
  if (value.enumValue) return value.enumValue;
  if (value.urlValue) return value.urlValue;
  if (value.enumValues?.length) return value.enumValues;
  return null;
}

function googleAttributePatch(submissions: GMBAttributeSubmission[]) {
  const attributeMask: string[] = [];
  const attributes: Prisma.InputJsonObject[] = [];

  for (const submission of submissions) {
    const definition = getAttributeById(submission.attributeId);
    if (!definition) continue;
    attributeMask.push(submission.attributeId);

    if (definition.valueType === "BOOL" && typeof submission.boolValue === "boolean") {
      attributes.push({ name: submission.attributeId, values: [submission.boolValue] });
    } else if (definition.valueType === "ENUM" && submission.enumValue) {
      attributes.push({ name: submission.attributeId, values: [submission.enumValue] });
    } else if (definition.valueType === "URL" && submission.urlValue) {
      attributes.push({ name: submission.attributeId, uriValues: [{ uri: submission.urlValue }] });
    } else if (
      definition.valueType === "REPEATED_ENUM" &&
      submission.enumValues &&
      submission.enumValues.length > 0
    ) {
      attributes.push({
        name: submission.attributeId,
        repeatedEnumValue: { setValues: submission.enumValues, unsetValues: [] },
      });
    }
    // A name present in attributeMask without a matching body entry deletes
    // that attribute, per Google's updateAttributes contract.
  }

  return { attributeMask, attributes };
}

function googleDate(value: string) {
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  return { year, month, day };
}

function googleTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return { hours, minutes };
}

function nextIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function googleSpecialHours(entries: z.infer<typeof SPECIAL_HOURS_ENTRY>[]) {
  return {
    specialHourPeriods: entries.map((entry) => {
      const startDate = googleDate(entry.date);
      if (entry.isClosed) return { startDate, closed: true };
      if (entry.is24Hours) {
        return {
          startDate,
          openTime: { hours: 0, minutes: 0 },
          endDate: startDate,
          closeTime: { hours: 24, minutes: 0 },
          closed: false,
        };
      }
      const closesNextDay = entry.closeTime === "00:00";
      return {
        startDate,
        openTime: googleTime(entry.openTime ?? "00:00"),
        endDate: googleDate(closesNextDay ? nextIsoDate(entry.date) : entry.date),
        closeTime: googleTime(entry.closeTime ?? "00:00"),
        closed: false,
      };
    }),
  };
}

export async function getGmbAttributeCatalog(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = CATALOG_QUERY.parse(req.query);
    if (!businessId) {
      return sendSuccess(res, { attributes: listAllAttributes(), scopedToBusiness: false });
    }
    if (!await requireOwnedBusiness(req, businessId)) return sendError(res, "Business not found", 404);
    const categoryRows = await prisma.gMBCategory.findMany({
      where: { businessId },
      orderBy: [{ isPrimary: "desc" }, { order: "asc" }],
      select: { categoryId: true, isPrimary: true },
    });
    const primaryId = categoryRows.find((row) => row.isPrimary)?.categoryId ?? null;
    return sendSuccess(res, {
      scopedToBusiness: true,
      attributes: getAttributesForCategoryIds(categoryRows.map((row) => row.categoryId)),
      requiredAttributeIds: getRequiredAttributesForPrimaryCategory(primaryId).map((item) => item.id),
      primaryCategoryId: primaryId,
    });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function getGmbAttributes(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = BUSINESS_QUERY.parse(req.query);
    if (!await requireOwnedBusiness(req, businessId)) return sendError(res, "Business not found", 404);
    return sendSuccess(res, { attributes: await loadCurrentAttributes(businessId) });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function updateGmbAttributes(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const body = ATTRIBUTES_BODY.parse(req.body);
    const { business, gmb } = await requireConnectedGmb(req, body.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    if (!gmb) return sendError(res, "Google Business Profile not connected", 404);
    const issues = validateAttributeSubmissions(body.attributes as GMBAttributeSubmission[]);
    if (issues.length) return sendError(res, "Request validation failed", 422);

    const current = await loadCurrentAttributes(body.businessId);
    const currentById = new Map(current.map((item) => [item.attributeId, item]));
    const proposedById = new Map(body.attributes.map((item) => [item.attributeId, item]));
    const changed: Array<{
      attributeId: string;
      displayName: string;
      previous: SimpleAttributeValue | null;
      proposed: SimpleAttributeValue;
    }> = [];
    for (const [attributeId, proposed] of proposedById) {
      const definition = getAttributeById(attributeId);
      if (!definition) continue;
      const currentItem = currentById.get(attributeId) ?? null;
      const currentValue: SimpleAttributeValue = currentItem ?? {
        boolValue: null,
        enumValue: null,
        urlValue: null,
        enumValues: [],
      };
      const proposedValue: SimpleAttributeValue = proposed;
      if (!sameAttributeValue(currentValue, proposedValue)) {
        changed.push({
          attributeId,
          displayName: definition.displayName,
          previous: currentItem,
          proposed: proposedValue,
        });
      }
    }
    for (const [attributeId, currentItem] of currentById) {
      if (proposedById.has(attributeId)) continue;
      const emptyValue = { boolValue: null, enumValue: null, urlValue: null, enumValues: [] };
      if (!sameAttributeValue(currentItem, emptyValue)) {
        changed.push({
          attributeId,
          displayName: getAttributeById(attributeId)?.displayName ?? currentItem.displayName,
          previous: currentItem,
          proposed: emptyValue,
        });
      }
    }
    if (!changed.length) {
      return sendSuccess(res, { queued: false, message: "Attributes already match the proposed values" });
    }
    const action = await queuePendingUserEdit({
      businessId: body.businessId,
      gmbId: gmb.id,
      actionType: "services_attributes",
      title: `Update ${changed.length} business attribute${changed.length === 1 ? "" : "s"}`,
      description: "Update the selected Google Business Profile attributes.",
      category: "completeness",
      priority: "medium",
      payloadJson: {
        requiresGooglePatch: true,
        attributes: body.attributes,
        googleAttributePatch: googleAttributePatch(body.attributes),
        changedAttributeIds: changed.map((item) => item.attributeId),
        profileReview: {
          diffs: changed.map((item) => ({
            field: item.attributeId,
            label: item.displayName,
            currentValue: serializeAttributeValue(item.previous),
            proposedValue: serializeAttributeValue(item.proposed),
            googleField: item.attributeId,
            applySupported: true,
          })),
        },
      },
    });
    await invalidateTenantCache(req.authUserId, body.businessId);
    return sendSuccess(res, { queued: true, action });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function getGmbCategories(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = BUSINESS_QUERY.parse(req.query);
    if (!await requireOwnedBusiness(req, businessId)) return sendError(res, "Business not found", 404);
    return sendSuccess(res, { selection: await loadCurrentCategories(businessId) });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function updateGmbCategories(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const body = CATEGORIES_BODY.parse(req.body);
    const { business, gmb } = await requireConnectedGmb(req, body.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    if (!gmb) return sendError(res, "Google Business Profile not connected", 404);
    const issues = validateCategorySelection({
      primaryId: body.primaryCategoryId,
      secondaryIds: body.secondaryCategoryIds,
    });
    if (issues.length) return sendError(res, "Request validation failed", 422);
    const current = await loadCurrentCategories(body.businessId);
    const primaryChanged = (current.primary?.id ?? null) !== body.primaryCategoryId;
    const currentSecondary = current.secondary.map((item) => item.id).sort();
    const proposedSecondaryIds = body.secondaryCategoryIds.slice().sort();
    const secondaryChanged = JSON.stringify(currentSecondary) !== JSON.stringify(proposedSecondaryIds);
    if (!primaryChanged && !secondaryChanged) {
      return sendSuccess(res, { queued: false, message: "Categories already match the proposed selection" });
    }
    const primary = body.primaryCategoryId ? getCategoryById(body.primaryCategoryId) : null;
    const secondary = body.secondaryCategoryIds
      .map((id) => getCategoryById(id))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const action = await queuePendingUserEdit({
      businessId: body.businessId,
      gmbId: gmb.id,
      actionType: "category_update",
      title: primaryChanged ? "Update primary category" : "Update secondary categories",
      description: primaryChanged
        ? "Changing the primary category may require re-verification by Google."
        : "Update the secondary category selection.",
      category: "completeness",
      priority: primaryChanged ? "high" : "medium",
      payloadJson: {
        requiresGooglePatch: true,
        primaryCategoryId: body.primaryCategoryId,
        secondaryCategoryIds: body.secondaryCategoryIds,
        businessData: {
          categories: [body.primaryCategoryId, ...body.secondaryCategoryIds]
            .filter((id): id is string => Boolean(id))
            .map((id) => `categories/${id}`),
        },
        warnsReverification: primaryChanged,
        profileReview: {
          diffs: [
            {
              field: "primaryCategory",
              label: "Primary category",
              currentValue: current.primary?.name ?? null,
              proposedValue: primary?.name ?? null,
              googleField: "primaryCategory",
              applySupported: true,
            },
            {
              field: "secondaryCategories",
              label: "Secondary categories",
              currentValue: current.secondary.map((item) => item.name),
              proposedValue: secondary.map((item) => item.name),
              googleField: "additionalCategories",
              applySupported: true,
            },
          ],
        },
      },
    });
    await invalidateTenantCache(req.authUserId, body.businessId);
    return sendSuccess(res, { queued: true, action });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function getGmbHours(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = BUSINESS_QUERY.parse(req.query);
    if (!await requireOwnedBusiness(req, businessId)) return sendError(res, "Business not found", 404);
    const [segments, gmb] = await Promise.all([
      loadCurrentHours(businessId),
      prisma.googleMyBusiness.findUnique({ where: { businessId }, select: { timezone: true } }),
    ]);
    return sendSuccess(res, { segments, timezone: gmb?.timezone ?? null });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function updateGmbHours(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const body = HOURS_BODY.parse(req.body);
    const { business, gmb } = await requireConnectedGmb(req, body.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    if (!gmb) return sendError(res, "Google Business Profile not connected", 404);
    const issues = validateBusinessHours(body.segments);
    if (issues.length) return sendError(res, "Request validation failed", 422);
    const diffs = diffWeeklyHours(await loadCurrentHours(body.businessId), body.segments);
    if (!diffs.length) {
      return sendSuccess(res, { queued: false, message: "Hours already match the proposed schedule" });
    }
    const action = await queuePendingUserEdit({
      businessId: body.businessId,
      gmbId: gmb.id,
      actionType: "hours_update",
      title: `Update business hours (${diffs.length} day${diffs.length === 1 ? "" : "s"})`,
      description: "Update the regular hours shown on Google Business Profile.",
      category: "completeness",
      priority: "high",
      payloadJson: {
        requiresGooglePatch: true,
        segments: body.segments,
        businessData: { regularHours: serializeForGbpPatch(body.segments) },
        profileReview: {
          diffs: diffs.map((item) => ({
            field: `hours.${DAY_NAMES[item.dayOfWeek]}`,
            label: DAY_NAMES[item.dayOfWeek],
            currentValue: item.previousLabel,
            proposedValue: item.proposedLabel,
            googleField: "regularHours",
            applySupported: true,
          })),
        },
      },
    });
    await invalidateTenantCache(req.authUserId, body.businessId);
    return sendSuccess(res, { queued: true, action });
  } catch (error) {
    return validationFailure(res, error);
  }
}

function specialHoursLabel(entry: {
  isClosed: boolean;
  is24Hours: boolean;
  openTime: string | null;
  closeTime: string | null;
}) {
  if (entry.isClosed) return "Closed";
  if (entry.is24Hours) return "Open 24 hours";
  return `${entry.openTime ?? "—"}–${entry.closeTime ?? "—"}`;
}

export async function getGmbSpecialHours(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = BUSINESS_QUERY.parse(req.query);
    if (!await requireOwnedBusiness(req, businessId)) return sendError(res, "Business not found", 404);
    const rows = await prisma.gMBSpecialHours.findMany({
      where: { businessId },
      orderBy: { date: "asc" },
      select: {
        id: true,
        date: true,
        openTime: true,
        closeTime: true,
        isClosed: true,
        is24Hours: true,
        label: true,
      },
    });
    return sendSuccess(res, {
      entries: rows.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
    });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function updateGmbSpecialHours(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const body = SPECIAL_HOURS_BODY.parse(req.body);
    const { business, gmb } = await requireConnectedGmb(req, body.businessId);
    if (!business) return sendError(res, "Business not found", 404);
    if (!gmb) return sendError(res, "Google Business Profile not connected", 404);
    const current = await prisma.gMBSpecialHours.findMany({
      where: { businessId: body.businessId },
      select: { date: true, openTime: true, closeTime: true, isClosed: true, is24Hours: true, label: true },
    });
    const currentByDate = new Map(current.map((item) => [item.date.toISOString().slice(0, 10), item]));
    const proposedByDate = new Map(body.entries.map((item) => [item.date, item]));
    const allDates = new Set([...currentByDate.keys(), ...proposedByDate.keys()]);
    const diffs = [...allDates].filter((date) => {
      const currentItem = currentByDate.get(date);
      const proposedItem = proposedByDate.get(date);
      return JSON.stringify(currentItem ? {
        openTime: currentItem.openTime,
        closeTime: currentItem.closeTime,
        isClosed: currentItem.isClosed,
        is24Hours: currentItem.is24Hours,
        label: currentItem.label,
      } : null) !== JSON.stringify(proposedItem ? {
        openTime: proposedItem.openTime,
        closeTime: proposedItem.closeTime,
        isClosed: proposedItem.isClosed,
        is24Hours: proposedItem.is24Hours,
        label: proposedItem.label,
      } : null);
    });
    if (!diffs.length) {
      return sendSuccess(res, { queued: false, message: "Special hours already match" });
    }
    const action = await queuePendingUserEdit({
      businessId: body.businessId,
      gmbId: gmb.id,
      actionType: "special_hours_update",
      title: `Update special / holiday hours (${diffs.length} date${diffs.length === 1 ? "" : "s"})`,
      description: "Update special hours for holidays and one-off dates.",
      category: "completeness",
      priority: "medium",
      payloadJson: {
        requiresGooglePatch: true,
        specialHourEntries: body.entries,
        businessData: { specialHours: googleSpecialHours(body.entries) },
        profileReview: {
          diffs: diffs.map((date) => {
            const currentItem = currentByDate.get(date);
            const proposedItem = proposedByDate.get(date);
            return {
              field: `specialHours.${date}`,
              label: proposedItem?.label ? `${date} (${proposedItem.label})` : date,
              currentValue: currentItem ? specialHoursLabel(currentItem) : null,
              proposedValue: proposedItem ? specialHoursLabel(proposedItem) : null,
              googleField: "specialHours",
              applySupported: true,
            };
          }),
        },
      },
    });
    await invalidateTenantCache(req.authUserId, body.businessId);
    return sendSuccess(res, { queued: true, action });
  } catch (error) {
    return validationFailure(res, error);
  }
}

export async function getGmbVerification(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.authUserId) return sendError(res, "Unauthorized", 401);
    const { businessId } = BUSINESS_QUERY.parse(req.query);
    if (!await requireOwnedBusiness(req, businessId)) return sendError(res, "Business not found", 404);
    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      select: {
        verified: true,
        verificationState: true,
        verifiedAt: true,
        moderationStatus: true,
        timezone: true,
        lastSyncAt: true,
        lastSyncError: true,
        refreshToken: true,
      },
    });
    if (!gmb) return sendSuccess(res, { connected: false, verification: null });
    return sendSuccess(res, {
      connected: true,
      verification: {
        verified: gmb.verified,
        verificationState: gmb.verificationState,
        verifiedAt: gmb.verifiedAt,
        moderationStatus: gmb.moderationStatus,
        timezone: gmb.timezone,
        lastSyncAt: gmb.lastSyncAt,
        // Never return Google/provider diagnostics or either OAuth token.
        lastSyncError: gmb.lastSyncError
          ? "Sync needs attention. Please reconnect or retry."
          : null,
        needsReconnect: !gmb.refreshToken,
      },
    });
  } catch (error) {
    return validationFailure(res, error);
  }
}
