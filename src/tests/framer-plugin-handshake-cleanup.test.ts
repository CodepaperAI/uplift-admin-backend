import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { cleanupExpiredFramerPluginHandshakes } from "../services/framer-plugin-handshake-cleanup.service";

describe("Framer plugin handshake cleanup", () => {
  test("deletes only rows older than the supplied authorization time", async () => {
    const observed: Date[] = [];
    const now = new Date("2026-08-08T14:00:00.000Z");
    const deleted = await cleanupExpiredFramerPluginHandshakes(
      {
        framerPluginHandshake: {
          deleteMany: async ({ where }) => {
            observed.push(where.expiresAt.lt);
            return { count: 3 };
          },
        },
      },
      now,
    );

    expect(deleted).toBe(3);
    expect(observed).toEqual([now]);
  });

  test("keeps cleanup demand-driven instead of registering an Inngest cron", () => {
    const inngestSource = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    const controllerSource = readFileSync(
      resolve(import.meta.dir, "../controllers/framer-plugin-handshake.controller.ts"),
      "utf8",
    );

    expect(inngestSource).not.toContain("framer.handshake-cleanup");
    expect(inngestSource).not.toContain("framerPluginHandshakeCleanupTask");
    expect(controllerSource).toContain(
      "cleanupExpiredFramerPluginHandshakes(prisma, now)",
    );
  });
});
