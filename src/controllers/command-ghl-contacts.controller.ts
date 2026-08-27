import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import { commandDayRange, commandDayForDate } from "../command/toronto-period";
import { parseCommandPagination, commandPaginationResult } from "../command/pagination";

/**
 * The GHL contacts created in a window, and whether each one reached a pipeline.
 *
 * Written to answer one question nothing else could: are the app's signups
 * arriving in the CRM? The panel could already show that only about a fifth of
 * them hold an *opportunity*, but an opportunity is not the same as a contact —
 * a signup could be filed as a contact and never enter a pipeline, and those two
 * outcomes need completely different fixes. Without contact-level data the
 * question could only be half answered, and half an answer about whether leads
 * are reaching sales is worse than none.
 *
 * Reads the mirror the hourly sync fills, not GHL itself. That matters for
 * interpretation, so `coverage.mirrorSyncedTo` reports how fresh the mirror is:
 * a contact created in the last hour may exist in GHL and legitimately not be
 * here yet, and reading its absence as a broken integration would be wrong.
 *
 * Read-only, and deliberately not a write path. Nothing here creates or repairs
 * a contact; it says what is and is not there.
 */

/** A window this endpoint will scan. Wider than a month is a report, not a check. */
const MAX_RANGE_DAYS = 62;
const ROW_CAP = 1000;

function parseDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export async function getCommandGhlContacts(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const today = commandDayForDate(new Date());
    const from = parseDay(req.query.from) ?? today;
    const to = parseDay(req.query.to) ?? from;
    if (from > to) {
      sendError(res, "The start of the range is after its end", 400);
      return;
    }
    const window = commandDayRange(from, to);
    const { start, end } = window;
    const days = window.dayCount;
    if (days > MAX_RANGE_DAYS) {
      sendError(
        res,
        `That range is ${days} days. This endpoint scans at most ${MAX_RANGE_DAYS}.`,
        400,
      );
      return;
    }

    const { page, pageSize, skip } = parseCommandPagination({
      page: req.query.page,
      pageSize: req.query.pageSize,
      defaultPageSize: 250,
      maxPageSize: ROW_CAP,
    });

    const cacheKey = `ghl-contacts-v1:${from}:${to}:${page}:${pageSize}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command GHL contacts");
      return;
    }

    const where = {
      isActive: true,
      providerCreatedAt: { gte: start, lt: end },
    } as const;

    const [total, contacts, newestMirrored, lastRun, bySource] = await Promise.all([
      prisma.commandGhlContact.count({ where }),
      prisma.commandGhlContact.findMany({
        where,
        orderBy: { providerCreatedAt: "desc" },
        skip,
        take: pageSize,
        select: {
          ghlContactId: true,
          name: true,
          email: true,
          phone: true,
          country: true,
          source: true,
          tags: true,
          providerCreatedAt: true,
        },
      }),
      // How far the mirror actually reaches, so an absence can be told apart
      // from a lag.
      prisma.commandGhlContact.aggregate({
        _max: { providerCreatedAt: true, lastSyncedAt: true },
      }),
      prisma.commandProviderSyncRun.findFirst({
        where: { provider: "ghl" },
        orderBy: { startedAt: "desc" },
        select: {
          status: true,
          startedAt: true,
          completedAt: true,
          inspected: true,
          updated: true,
          error: true,
        },
      }),
      // Which route these contacts arrived by. The whole point of the check: an
      // app signup and a Facebook lead should look different here.
      prisma.commandGhlContact.groupBy({
        by: ["source"],
        where,
        _count: { _all: true },
      }),
    ]);

    // Which of the returned contacts hold a pipeline opportunity. A contact
    // with no opportunity is in the CRM but not in front of a rep, and that is
    // the distinction this endpoint exists to make.
    const contactIds = contacts.flatMap((contact) =>
      contact.ghlContactId ? [contact.ghlContactId] : [],
    );
    const withOpportunity = contactIds.length
      ? await prisma.commandGhlOpportunity.findMany({
          where: { isActive: true, ghlContactId: { in: contactIds } },
          select: { ghlContactId: true, pipelineStageName: true, status: true },
        })
      : [];
    const opportunityByContact = new Map(
      withOpportunity.flatMap((opportunity) =>
        opportunity.ghlContactId
          ? [[opportunity.ghlContactId, opportunity] as const]
          : [],
      ),
    );

    const payload = {
      range: { from, to, days, timeZone: "America/Toronto" },
      pagination: commandPaginationResult({ page, pageSize, total }),
      bySource: Object.fromEntries(
        bySource
          .map((row) => [row.source ?? "(none)", row._count._all] as const)
          .sort(([, left], [, right]) => right - left),
      ),
      coverage: {
        /**
         * Newest contact the mirror holds, and when it last ran. Anything newer
         * than this may exist in GHL and simply not be synced yet.
         */
        mirrorNewestContactAt:
          newestMirrored._max.providerCreatedAt?.toISOString() ?? null,
        mirrorLastSyncedAt: newestMirrored._max.lastSyncedAt?.toISOString() ?? null,
        lastSync: lastRun
          ? {
              ...lastRun,
              startedAt: lastRun.startedAt.toISOString(),
              completedAt: lastRun.completedAt?.toISOString() ?? null,
            }
          : null,
        rowCap: ROW_CAP,
      },
      contacts: contacts.map((contact) => {
        const opportunity = contact.ghlContactId
          ? opportunityByContact.get(contact.ghlContactId)
          : undefined;
        return {
          ghlContactId: contact.ghlContactId,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          country: contact.country,
          source: contact.source,
          tags: contact.tags,
          createdAt: contact.providerCreatedAt?.toISOString() ?? null,
          /** In the CRM *and* in a pipeline, or only in the CRM. */
          hasOpportunity: Boolean(opportunity),
          opportunityStage: opportunity?.pipelineStageName ?? null,
          opportunityStatus: opportunity?.status ?? null,
        };
      }),
    };

    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command GHL contacts");
  } catch (error: unknown) {
    sendError(res, "Failed to load Command GHL contacts", 500, error);
  }
}
