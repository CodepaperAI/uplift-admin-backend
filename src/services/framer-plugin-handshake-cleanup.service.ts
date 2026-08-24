import { prisma } from "../config/db.config";

type FramerHandshakeCleanupClient = {
  framerPluginHandshake: {
    deleteMany(input: {
      where: { expiresAt: { lt: Date } };
    }): Promise<{ count: number }>;
  };
};

/**
 * Framer handshakes are short-lived, single-use authorization records.
 * Cleanup is demand-driven so an unused integration does not create a
 * permanent background job, while abandoned sessions are still removed the
 * next time a Framer connection begins.
 */
export async function cleanupExpiredFramerPluginHandshakes(
  client: FramerHandshakeCleanupClient = prisma,
  now = new Date(),
): Promise<number> {
  const result = await client.framerPluginHandshake.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return result.count;
}
