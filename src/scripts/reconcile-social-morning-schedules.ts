import { prisma } from "../config/db.config";
import { reconcileFutureSocialMorningSchedules } from "../services/social-schedule-reconciliation.service";

const apply = process.argv.includes("--apply");
const businessIdArgument = process.argv.find((argument) =>
  argument.startsWith("--business-id="),
);
const businessId = businessIdArgument?.slice("--business-id=".length).trim();

if (
  apply &&
  process.env.SOCIAL_SCHEDULE_RECONCILIATION_APPROVED !== "true"
) {
  throw new Error(
    "Set SOCIAL_SCHEDULE_RECONCILIATION_APPROVED=true before applying schedule changes",
  );
}

try {
  const summary = await reconcileFutureSocialMorningSchedules(
    { apply, businessId: businessId || undefined },
    prisma,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await prisma.$disconnect();
}
