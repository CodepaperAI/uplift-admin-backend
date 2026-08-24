import { prisma } from "../config/db.config";
import {
  GhlReadOnlyClient,
  type GhlCalendarEvent,
  type GhlCallMessage,
} from "./ghl-readonly.client";
import { commandMonthRange, currentCommandMonth } from "./toronto-period";

type ActivityTotals = {
  calls: number;
  connects: number;
  meetingsBooked: number;
  meetingsHeld: number;
};

export function commandGhlActivityRunCounts(input: {
  inspected: number;
  created: number;
  updated: number;
  unchanged: number;
  month?: string;
}) {
  return {
    inspected: input.inspected,
    created: input.created,
    updated: input.updated,
    unchanged: input.unchanged,
  };
}

const CONNECTED_CALL_STATUSES = new Set(["connected", "answered", "completed"]);
const HELD_APPOINTMENT_STATUSES = new Set([
  "showed",
  "completed",
  "attended",
]);

export function aggregateGhlActivity(input: {
  calls: readonly GhlCallMessage[];
  eventsByUserId: Readonly<Record<string, readonly GhlCalendarEvent[]>>;
}): Record<string, ActivityTotals> {
  const totals = new Map<string, ActivityTotals>();
  const ensure = (userId: string) => {
    const existing = totals.get(userId) ?? {
      calls: 0,
      connects: 0,
      meetingsBooked: 0,
      meetingsHeld: 0,
    };
    totals.set(userId, existing);
    return existing;
  };
  const seenCalls = new Set<string>();
  for (const call of input.calls) {
    const userId = call.userId?.trim();
    if (!userId || !call.id || seenCalls.has(call.id)) continue;
    seenCalls.add(call.id);
    const value = ensure(userId);
    value.calls += 1;
    const callStatus = (call.meta?.callStatus || call.status || "").toLowerCase();
    if (CONNECTED_CALL_STATUSES.has(callStatus)) value.connects += 1;
  }
  for (const [userId, events] of Object.entries(input.eventsByUserId)) {
    const value = ensure(userId);
    const seenEvents = new Set<string>();
    for (const event of events) {
      if (!event.id || seenEvents.has(event.id)) continue;
      seenEvents.add(event.id);
      value.meetingsBooked += 1;
      if (
        HELD_APPOINTMENT_STATUSES.has(
          event.appointmentStatus?.trim().toLowerCase() ?? "",
        )
      ) {
        value.meetingsHeld += 1;
      }
    }
  }
  return Object.fromEntries(totals);
}

export async function collectGhlCallMessages(
  client: Pick<GhlReadOnlyClient, "callMessagesPage">,
  input: { startDate: string; endDate: string; maxPages?: number },
): Promise<GhlCallMessage[]> {
  const calls: GhlCallMessage[] = [];
  const seenPages = new Set<string>();
  let cursor: string | undefined;
  const maxPages = Math.max(1, Math.min(10_000, input.maxPages ?? 10_000));
  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.callMessagesPage({
      startDate: input.startDate,
      endDate: input.endDate,
      cursor,
    });
    const pageIdentity = result.messages
      .map((message, index) => message.id || `missing:${index}`)
      .join("|");
    if (result.messages.length > 0 && seenPages.has(pageIdentity)) {
      throw new Error("GHL call export page did not advance");
    }
    if (result.messages.length > 0) seenPages.add(pageIdentity);
    calls.push(...result.messages);
    if (!result.nextCursor) return calls;
    // HighLevel v3 uses a short-lived server-side export cursor. The same
    // cursor value can legitimately advance across calls, so page identity—not
    // cursor inequality—is the loop-safety invariant.
    cursor = result.nextCursor;
  }
  throw new Error("GHL call export exceeded the page limit");
}

export async function syncCommandGhlActivity(
  client: GhlReadOnlyClient,
  month = currentCommandMonth(),
) {
  const period = commandMonthRange(month);
  const run = await prisma.commandProviderSyncRun.create({
    data: { provider: "ghl_activity", mode: "hourly_read_sync" },
    select: { id: true },
  });
  let inspected = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    const calls = await collectGhlCallMessages(client, {
      startDate: period.start.toISOString(),
      endDate: period.end.toISOString(),
    });
    const reps = await prisma.commandRepProfile.findMany({
      where: { isActive: true, ghlUserId: { not: null } },
      select: { id: true, ghlUserId: true },
    });
    const eventsByUserId: Record<string, GhlCalendarEvent[]> = {};
    for (const rep of reps) {
      if (!rep.ghlUserId) continue;
      eventsByUserId[rep.ghlUserId] = await client.calendarEventsForUser({
        userId: rep.ghlUserId,
        startTime: period.start,
        endTime: period.end,
      });
    }
    const totalsByGhlUserId = aggregateGhlActivity({ calls, eventsByUserId });
    inspected =
      calls.length +
      Object.values(eventsByUserId).reduce((sum, events) => sum + events.length, 0);
    const existing = await prisma.commandRepActivity.findMany({
      where: {
        periodMonth: month,
        source: "ghl_sync",
        repId: { in: reps.map((rep) => rep.id) },
      },
      select: {
        repId: true,
        calls: true,
        connects: true,
        meetingsBooked: true,
        meetingsHeld: true,
      },
    });
    const existingByRep = new Map(existing.map((row) => [row.repId, row]));
    for (const rep of reps) {
      if (!rep.ghlUserId) continue;
      const totals = totalsByGhlUserId[rep.ghlUserId] ?? {
        calls: 0,
        connects: 0,
        meetingsBooked: 0,
        meetingsHeld: 0,
      };
      const previous = existingByRep.get(rep.id);
      const changed =
        !previous ||
        previous.calls !== totals.calls ||
        previous.connects !== totals.connects ||
        previous.meetingsBooked !== totals.meetingsBooked ||
        previous.meetingsHeld !== totals.meetingsHeld;
      await prisma.commandRepActivity.upsert({
        where: {
          repId_periodMonth_source: {
            repId: rep.id,
            periodMonth: month,
            source: "ghl_sync",
          },
        },
        create: {
          repId: rep.id,
          periodMonth: month,
          source: "ghl_sync",
          ...totals,
        },
        update: totals,
      });
      if (!previous) created += 1;
      else if (changed) updated += 1;
      else unchanged += 1;
    }
    const result = { inspected, created, updated, unchanged, month };
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        ...commandGhlActivityRunCounts(result),
        completedAt: new Date(),
      },
    });
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
