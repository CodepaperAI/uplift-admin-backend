import { prisma } from "../config/db.config";

type BusinessOwnerLookupArgs = {
  where: {
    id: string;
    userId: string;
    isActive: true;
  };
  select: { id: true };
};

type BusinessOwnerLookup = (
  args: BusinessOwnerLookupArgs,
) => Promise<{ id: string } | null>;

export async function getOwnedActiveBusiness(
  input: { businessId: string; userId: string },
  findBusiness: BusinessOwnerLookup = (args) => prisma.business.findFirst(args),
) {
  if (!input.businessId || !input.userId) return null;

  return findBusiness({
    where: {
      id: input.businessId,
      userId: input.userId,
      isActive: true,
    },
    select: { id: true },
  });
}
