import { gmbDemoDataService, isGmbDemoModeEnabled } from "../services/gmb-demo-data.service";
import { prisma } from "../config/db.config";

function getArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  if (!isGmbDemoModeEnabled()) {
    throw new Error(
      "GMB demo seeding requires GMB_DEMO_MODE=true and NODE_ENV must not be production",
    );
  }

  const businessId = getArg("businessId");
  if (!businessId) {
    throw new Error("Missing --businessId=<business-id>");
  }

  const reset = process.argv.includes("--reset");
  const result = reset
    ? await gmbDemoDataService.resetDemoBusiness(businessId)
    : await gmbDemoDataService.connectDemoBusiness(businessId);

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
