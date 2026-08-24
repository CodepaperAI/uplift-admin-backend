import { prisma } from "../config/db.config";
import { reconcileFutureSocialPlatformCalendars } from "../services/social-platform-calendar-reconciliation.service";

const apply = process.argv.includes("--apply");
const businessArgument = process.argv.find((argument) =>
  argument.startsWith("--business-id="),
);
const businessId = businessArgument?.slice("--business-id=".length).trim() || undefined;

try {
  const result = await reconcileFutureSocialPlatformCalendars(
    { apply, businessId },
    prisma,
  );
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...result }));
} finally {
  await prisma.$disconnect();
}
