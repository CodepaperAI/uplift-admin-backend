import { prisma } from "../config/db.config";

/**
 * Helper: Verify user exists and return user ID
 *
 * With Better Auth, userId IS the database User.id (since Better Auth uses Prisma adapter
 * and stores users directly in the database). This function verifies the user exists.
 *
 * @param userId - The Better Auth user ID (which is the database User.id)
 * @returns The database User ID if user exists, or null if not found
 */
export async function getDatabaseUserId(
  userId: string
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
    },
  });
  return user?.id || null;
}
