import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  GhlReadOnlyClient,
  type GhlContact,
  type GhlOpportunity,
} from "./ghl-readonly.client";
import {
  projectCommandAccount,
  projectCommandAccountGhlOwner,
} from "./account-projection.service";
import { invalidateCommandCache } from "../utils/command-cache";

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function contactName(contact: GhlContact): string | null {
  const composed = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return contact.name?.trim() || composed || null;
}

function decimal(value: number | string | undefined): Prisma.Decimal | null {
  if (value === undefined || value === "") return null;
  try {
    return new Prisma.Decimal(String(value));
  } catch {
    return null;
  }
}

export async function syncCommandGhlReadModels(client: GhlReadOnlyClient) {
  const run = await prisma.commandProviderSyncRun.create({
    data: { provider: "ghl", mode: "hourly_read_sync" },
    select: { id: true },
  });
  let inspected = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  try {
    const [existingContacts, existingOpportunities, pipelines] =
      await Promise.all([
        prisma.commandGhlContact.findMany({ select: { ghlContactId: true } }),
        prisma.commandGhlOpportunity.findMany({
          select: {
            ghlOpportunityId: true,
            assignedToGhlId: true,
            furthestStageId: true,
            furthestStageName: true,
            furthestStageIndex: true,
          },
        }),
        client.pipelines(),
      ]);
    const repProfiles = await prisma.commandRepProfile.findMany({
      where: { ghlUserId: { not: null } },
      select: { id: true, ghlUserId: true },
    });
    const repIdByGhlUserId = new Map(
      repProfiles.flatMap((rep) =>
        rep.ghlUserId ? [[rep.ghlUserId, rep.id] as const] : [],
      ),
    );
    const existingContactIds = new Set(
      existingContacts.map((row) => row.ghlContactId),
    );
    const existingOpportunityById = new Map(
      existingOpportunities.map((row) => [row.ghlOpportunityId, row]),
    );
    const seenContactIds = new Set<string>();
    const seenOpportunityIds = new Set<string>();
    const pipelineNames = new Map<string, string>();
    const stageNames = new Map<string, string>();
    const stageIndexes = new Map<string, number>();
    for (const pipeline of pipelines) {
      if (pipeline.name) pipelineNames.set(pipeline.id, pipeline.name);
      for (const [index, stage] of (pipeline.stages ?? []).entries()) {
        if (stage.name) stageNames.set(`${pipeline.id}:${stage.id}`, stage.name);
        stageIndexes.set(`${pipeline.id}:${stage.id}`, index);
      }
    }

    let contactCursor: { id: string; timestamp?: number } | undefined;
    for (let page = 0; page < 10_000; page += 1) {
      const contacts = await client.contactsPage(contactCursor);
      if (contacts.length === 0) break;
      for (const contact of contacts) {
        if (!contact.id) continue;
        inspected += 1;
        seenContactIds.add(contact.id);
        const now = new Date();
        await prisma.commandGhlContact.upsert({
          where: { ghlContactId: contact.id },
          create: {
            ghlContactId: contact.id,
            locationId: contact.locationId ?? process.env.GHL_LOCATION_ID ?? "",
            name: contactName(contact),
            email: contact.email ?? null,
            phone: contact.phone ?? null,
            country: contact.country ?? null,
            source: contact.source ?? null,
            assignedToGhlId: contact.assignedTo ?? null,
            tags: contact.tags ?? [],
            customFields:
              contact.customFields === undefined
                ? Prisma.JsonNull
                : (contact.customFields as Prisma.InputJsonValue),
            providerCreatedAt: date(contact.dateAdded),
            providerUpdatedAt: date(contact.dateUpdated),
            lastSyncedAt: now,
          },
          update: {
            locationId: contact.locationId ?? process.env.GHL_LOCATION_ID ?? "",
            name: contactName(contact),
            email: contact.email ?? null,
            phone: contact.phone ?? null,
            country: contact.country ?? null,
            source: contact.source ?? null,
            assignedToGhlId: contact.assignedTo ?? null,
            tags: contact.tags ?? [],
            customFields:
              contact.customFields === undefined
                ? Prisma.JsonNull
                : (contact.customFields as Prisma.InputJsonValue),
            providerCreatedAt: date(contact.dateAdded),
            providerUpdatedAt: date(contact.dateUpdated),
            isActive: true,
            lastSyncedAt: now,
          },
        });
        await projectCommandAccount({
          ghlContactId: contact.id,
          name: contactName(contact),
          email: contact.email ?? null,
          assignedToGhlId: contact.assignedTo ?? null,
        });
        if (existingContactIds.has(contact.id)) updated += 1;
        else created += 1;
      }
      if (contacts.length < 100) break;
      const last = contacts[contacts.length - 1];
      if (!last?.id || last.id === contactCursor?.id) {
        throw new Error("GHL contacts pagination did not advance");
      }
      contactCursor = {
        id: last.id,
        timestamp: last.dateAdded
          ? new Date(last.dateAdded).getTime()
          : undefined,
      };
    }

    for (let page = 1; page <= 10_000; page += 1) {
      const opportunities = await client.opportunitiesPage(page);
      if (opportunities.length === 0) break;
      for (const opportunity of opportunities) {
        if (!opportunity.id) continue;
        inspected += 1;
        seenOpportunityIds.add(opportunity.id);
        const pipelineId = opportunity.pipelineId ?? "unknown";
        const pipelineStageId = opportunity.pipelineStageId ?? "unknown";
        const stageKey = `${pipelineId}:${pipelineStageId}`;
        const pipelineStageName = stageNames.get(stageKey) ?? null;
        const pipelineStageIndex = stageIndexes.get(stageKey) ?? null;
        const existing = existingOpportunityById.get(opportunity.id);
        const keepExistingFurthest =
          existing?.furthestStageIndex !== null &&
          existing?.furthestStageIndex !== undefined &&
          (pipelineStageIndex === null ||
            existing.furthestStageIndex >= pipelineStageIndex);
        const furthestStageId = keepExistingFurthest
          ? existing.furthestStageId
          : pipelineStageId;
        const furthestStageName = keepExistingFurthest
          ? existing.furthestStageName
          : pipelineStageName;
        const furthestStageIndex = keepExistingFurthest
          ? existing.furthestStageIndex
          : pipelineStageIndex;
        const now = new Date();
        const nextAssignedTo = opportunity.assignedTo ?? null;
        await prisma.$transaction(async (tx) => {
          await tx.commandGhlOpportunity.upsert({
            where: { ghlOpportunityId: opportunity.id },
            create: {
            ghlOpportunityId: opportunity.id,
            locationId:
              opportunity.locationId ?? process.env.GHL_LOCATION_ID ?? "",
            ghlContactId: opportunity.contactId ?? null,
            name: opportunity.name?.trim() || "Untitled opportunity",
            monetaryValue: decimal(opportunity.monetaryValue),
            pipelineId,
            pipelineName: pipelineNames.get(pipelineId) ?? null,
            pipelineStageId,
            pipelineStageName,
            pipelineStageIndex,
            furthestStageId,
            furthestStageName,
            furthestStageIndex,
            assignedToGhlId: nextAssignedTo,
            status: opportunity.status ?? "unknown",
            source: opportunity.source ?? null,
            lostReasonId: opportunity.lostReasonId ?? null,
            lastStatusChangeAt: date(opportunity.lastStatusChangeAt),
            lastStageChangeAt: date(opportunity.lastStageChangeAt),
            lastActionAt: date(opportunity.lastActionDate),
            providerCreatedAt: date(opportunity.createdAt),
            providerUpdatedAt: date(opportunity.updatedAt),
            expectedCloseDate: date(opportunity.forecastExpectedCloseDate),
            lastSyncedAt: now,
          },
            update: {
            locationId:
              opportunity.locationId ?? process.env.GHL_LOCATION_ID ?? "",
            ghlContactId: opportunity.contactId ?? null,
            name: opportunity.name?.trim() || "Untitled opportunity",
            monetaryValue: decimal(opportunity.monetaryValue),
            pipelineId,
            pipelineName: pipelineNames.get(pipelineId) ?? null,
            pipelineStageId,
            pipelineStageName,
            pipelineStageIndex,
            furthestStageId,
            furthestStageName,
            furthestStageIndex,
            assignedToGhlId: nextAssignedTo,
            status: opportunity.status ?? "unknown",
            source: opportunity.source ?? null,
            lostReasonId: opportunity.lostReasonId ?? null,
            lastStatusChangeAt: date(opportunity.lastStatusChangeAt),
            lastStageChangeAt: date(opportunity.lastStageChangeAt),
            lastActionAt: date(opportunity.lastActionDate),
            providerCreatedAt: date(opportunity.createdAt),
            providerUpdatedAt: date(opportunity.updatedAt),
            expectedCloseDate: date(opportunity.forecastExpectedCloseDate),
            isActive: true,
            lastSyncedAt: now,
            },
          });
          if (!existing || existing.assignedToGhlId !== nextAssignedTo) {
            await tx.commandGhlLeadAssignment.updateMany({
              where: {
                ghlOpportunityId: opportunity.id,
                observedTo: null,
              },
              data: { observedTo: now },
            });
            await tx.commandGhlLeadAssignment.create({
              data: {
                ghlOpportunityId: opportunity.id,
                assignedToGhlId: nextAssignedTo,
                repId: nextAssignedTo
                  ? (repIdByGhlUserId.get(nextAssignedTo) ?? null)
                  : null,
                observedFrom: now,
                sourceSyncRunId: run.id,
                providerUpdatedAt: date(opportunity.updatedAt),
              },
            });
          }
        });
        if (existingOpportunityById.has(opportunity.id)) updated += 1;
        else created += 1;
      }
      if (opportunities.length < 100) break;
    }

    const latestOpportunityOwners =
      seenOpportunityIds.size > 0
        ? await prisma.commandGhlOpportunity.findMany({
            where: {
              ghlOpportunityId: { in: [...seenOpportunityIds] },
              ghlContactId: { not: null },
              assignedToGhlId: { not: null },
            },
            distinct: ["ghlContactId"],
            orderBy: [
              { ghlContactId: "asc" },
              { providerUpdatedAt: "desc" },
              { lastActionAt: "desc" },
              { ghlOpportunityId: "desc" },
            ],
            select: { ghlContactId: true, assignedToGhlId: true },
          })
        : [];
    for (const owner of latestOpportunityOwners) {
      await projectCommandAccountGhlOwner(
        owner.ghlContactId,
        owner.assignedToGhlId,
      );
    }

    const [contactsDeactivated, opportunitiesDeactivated] = await Promise.all([
      prisma.commandGhlContact.updateMany({
        where: {
          isActive: true,
          ...(seenContactIds.size > 0
            ? { ghlContactId: { notIn: [...seenContactIds] } }
            : {}),
        },
        data: { isActive: false },
      }),
      prisma.commandGhlOpportunity.updateMany({
        where: {
          isActive: true,
          ...(seenOpportunityIds.size > 0
            ? { ghlOpportunityId: { notIn: [...seenOpportunityIds] } }
            : {}),
        },
        data: { isActive: false },
      }),
    ]);
    updated += contactsDeactivated.count + opportunitiesDeactivated.count;
    unchanged = Math.max(0, inspected - created - updated);

    const result = { inspected, created, updated, unchanged };
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: { status: "completed", ...result, completedAt: new Date() },
    });
    await invalidateCommandCache();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        inspected,
        created,
        updated,
        unchanged,
        error: message.slice(0, 2000),
        completedAt: new Date(),
      },
    });
    throw error;
  }
}
