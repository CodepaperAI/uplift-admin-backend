import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { GhlReadOnlyClient } from "../command/ghl-readonly.client";

/**
 * Who is who in GoHighLevel, and which of them already own pipeline.
 *
 * The hourly sync stores `assignedToGhlId` on every opportunity but nothing maps
 * that id to a person, so the panel reports all 3,300 opportunities as
 * "Unassigned" and no rep's leaderboard row can ever fill in. There are nine
 * distinct assignee ids in the pipeline and, until this endpoint, no way to tell
 * whose they were.
 *
 * Returns each GHL user alongside their live opportunity count and whether an
 * Uplift rep profile already claims their id — which is exactly what someone
 * needs to wire the two systems together without guessing. Assigning the wrong
 * id would hand one rep another rep's deals and their commission, so the mapping
 * is presented for a human to confirm rather than inferred.
 *
 * Read-only. It never writes the mapping; `PATCH /reps/:id` does that.
 */
export async function getCommandGhlUsers(
  req: Request,
  res: Response,
): Promise<void> {
  const token = process.env.GHL_COMMAND_READ_TOKEN?.trim();
  const locationId = process.env.GHL_COMMAND_LOCATION_ID?.trim();
  if (!token || !locationId) {
    // Named precisely, because "GHL is broken" sends someone to the wrong
    // place: the sync that fills the tables runs elsewhere and is unaffected.
    sendError(
      res,
      "This service has no GoHighLevel credentials configured, so users cannot be listed. GHL_COMMAND_READ_TOKEN and GHL_COMMAND_LOCATION_ID are set on the service that runs the sync, not on this one.",
      503,
    );
    return;
  }

  try {
    const client = new GhlReadOnlyClient({
      token,
      locationId,
      baseUrl: process.env.GHL_COMMAND_API_BASE_URL,
      usersVersion: process.env.GHL_COMMAND_USERS_VERSION,
    });
    const [users, ownership, reps] = await Promise.all([
      client.users(),
      prisma.commandGhlOpportunity.groupBy({
        by: ["assignedToGhlId"],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.commandRepProfile.findMany({
        select: { id: true, name: true, ghlUserId: true, isActive: true },
      }),
    ]);

    const opportunityCount = new Map(
      ownership.flatMap((row) =>
        row.assignedToGhlId
          ? ([[row.assignedToGhlId, row._count._all]] as const)
          : [],
      ),
    );
    const repByGhlId = new Map(
      reps.flatMap((rep) => (rep.ghlUserId ? ([[rep.ghlUserId, rep]] as const) : [])),
    );

    const rows = users
      .map((user) => ({
        ghlUserId: user.id,
        name:
          user.name?.trim() ||
          [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
          null,
        email: user.email ?? null,
        phone: user.phone ?? null,
        roleType: user.roles?.type ?? null,
        role: user.roles?.role ?? null,
        openOpportunities: opportunityCount.get(user.id) ?? 0,
        linkedRep: repByGhlId.get(user.id)
          ? {
              id: repByGhlId.get(user.id)!.id,
              name: repByGhlId.get(user.id)!.name,
            }
          : null,
      }))
      // Most pipeline first: whoever owns the most deals is who someone is
      // usually looking for.
      .sort((left, right) => right.openOpportunities - left.openOpportunities);

    /**
     * Assignee ids in the pipeline that GHL's user list does not explain —
     * deleted staff, or an agency-level user outside this location. Reported so
     * a gap in the mapping is visible rather than looking like nobody owns
     * those deals.
     */
    const unmatchedAssignees = [...opportunityCount.entries()]
      .filter(([id]) => !users.some((user) => user.id === id))
      .map(([ghlUserId, openOpportunities]) => ({ ghlUserId, openOpportunities }))
      .sort((left, right) => right.openOpportunities - left.openOpportunities);

    sendSuccess(
      res,
      {
        users: rows,
        unmatchedAssignees,
        repsWithoutGhlId: reps
          .filter((rep) => rep.isActive && !rep.ghlUserId)
          .map((rep) => ({ id: rep.id, name: rep.name })),
      },
      "Command GHL users",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to list GoHighLevel users", 502, error);
  }
}
