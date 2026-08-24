import { describe, expect, it } from "bun:test";
import {
  aggregateGhlActivity,
  collectGhlCallMessages,
  commandGhlActivityRunCounts,
} from "../command/ghl-activity-sync.service";
import { GhlReadOnlyClient } from "../command/ghl-readonly.client";

describe("Command GHL activity projection", () => {
  it("persists only provider-run columns and keeps month in the return payload", () => {
    expect(
      commandGhlActivityRunCounts({
        inspected: 10,
        created: 2,
        updated: 3,
        unchanged: 5,
        month: "2026-08",
      }),
    ).toEqual({ inspected: 10, created: 2, updated: 3, unchanged: 5 });
  });

  it("counts unique calls/connects and booked/held meetings by GHL user", () => {
    expect(
      aggregateGhlActivity({
        calls: [
          { id: "c1", userId: "u1", meta: { callStatus: "answered" } },
          { id: "c1", userId: "u1", meta: { callStatus: "answered" } },
          { id: "c2", userId: "u1", status: "failed" },
        ],
        eventsByUserId: {
          u1: [
            { id: "e1", appointmentStatus: "showed" },
            { id: "e2", appointmentStatus: "no_show" },
          ],
        },
      }),
    ).toEqual({
      u1: { calls: 2, connects: 1, meetingsBooked: 2, meetingsHeld: 1 },
    });
  });

  it("uses only the documented GET endpoints, versions, filters, and cursors", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      const payload = url.includes("/conversations/")
        ? { messages: [], nextCursor: null, total: 0 }
        : { events: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new GhlReadOnlyClient({
      token: "secret",
      locationId: "loc",
      baseUrl: "https://ghl.example",
      fetchImpl,
    });
    await client.callMessagesPage({
      startDate: "2026-08-01T04:00:00.000Z",
      endDate: "2026-09-01T04:00:00.000Z",
      cursor: "next",
    });
    await client.calendarEventsForUser({
      userId: "rep-user",
      startTime: new Date("2026-08-01T04:00:00.000Z"),
      endTime: new Date("2026-09-01T04:00:00.000Z"),
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.init?.method === "GET")).toBe(true);
    expect(new Headers(requests[0]!.init?.headers).get("Version")).toBe("v3");
    expect(new URL(requests[0]!.url).searchParams.get("channel")).toBe("Call");
    expect(new URL(requests[0]!.url).searchParams.get("cursor")).toBe("next");
    expect(new URL(requests[1]!.url).searchParams.get("userId")).toBe("rep-user");
  });

  it("accepts HighLevel's stable server-side cursor while pages advance", async () => {
    let page = 0;
    const messages = await collectGhlCallMessages(
      {
        async callMessagesPage() {
          page += 1;
          if (page === 1) {
            return {
              messages: [{ id: "call-1", userId: "rep-1" }],
              nextCursor: "stable-export-cursor",
              total: 2,
            };
          }
          return {
            messages: [{ id: "call-2", userId: "rep-1" }],
            nextCursor: null,
            total: 2,
          };
        },
      },
      {
        startDate: "2026-08-01T04:00:00.000Z",
        endDate: "2026-09-01T04:00:00.000Z",
      },
    );
    expect(messages.map((message) => message.id)).toEqual(["call-1", "call-2"]);
  });

  it("stops a repeated page even when HighLevel keeps returning a cursor", async () => {
    await expect(
      collectGhlCallMessages(
        {
          async callMessagesPage() {
            return {
              messages: [{ id: "same-call" }],
              nextCursor: "stable-export-cursor",
              total: 2,
            };
          },
        },
        {
          startDate: "2026-08-01T04:00:00.000Z",
          endDate: "2026-09-01T04:00:00.000Z",
        },
      ),
    ).rejects.toThrow("page did not advance");
  });
});
