import { prisma } from "../config/db.config";
import { backfillManagedBacklinkSourceBlogIds } from "../services/managed-backlinks.service";

async function main() {
  const limitArg = process.argv[2];
  const parsedLimit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
  const limit =
    typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : undefined;

  const result = await backfillManagedBacklinkSourceBlogIds({ limit });
  console.log(
    JSON.stringify(
      {
        message: "Managed backlink source-blog backfill complete",
        ...result,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("Managed backlink backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
