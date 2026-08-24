import { z } from "zod";

export const COMMAND_ACTIVITY_INPUT = z
  .object({
    repId: z.string().uuid(),
    periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    calls: z.number().int().nonnegative().max(1_000_000),
    connects: z.number().int().nonnegative().max(1_000_000),
    meetingsBooked: z.number().int().nonnegative().max(1_000_000),
    meetingsHeld: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.connects > value.calls) {
      context.addIssue({ code: "custom", path: ["connects"], message: "Connects cannot exceed calls" });
    }
    if (value.meetingsHeld > value.meetingsBooked) {
      context.addIssue({ code: "custom", path: ["meetingsHeld"], message: "Meetings held cannot exceed meetings booked" });
    }
  });
